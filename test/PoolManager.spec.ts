import snapshotGasCost from '@uniswap/snapshot-gas-cost'
import { BigNumber, Wallet } from 'ethers'
import hre, { ethers, waffle } from 'hardhat'
import {
  EmptyTestHooks,
  PoolDonateTest,
  PoolManager,
  PoolManagerReentrancyTest,
  PoolManagerTest,
  PoolModifyPositionTest,
  ProtocolFeeControllerTest,
  PoolSwapTest,
  TestERC20,
  PoolTakeTest,
} from '../typechain'
import { MAX_TICK_SPACING, ADDRESS_ZERO } from './shared/constants'
import { expect } from './shared/expect'
import { tokensFixture } from './shared/fixtures'
import { encodeSqrtPriceX96, expandTo18Decimals, FeeAmount, getPoolId, MaxUint128 } from './shared/utilities'
import { deployMockContract, MockedContract, setCode } from './shared/mockContract'

const createFixtureLoader = waffle.createFixtureLoader

const { constants } = ethers

describe('PoolManager', () => {
  let wallet: Wallet, other: Wallet

  let manager: PoolManager
  let lockTest: PoolManagerTest
  let swapTest: PoolSwapTest
  let feeControllerTest: ProtocolFeeControllerTest
  let modifyPositionTest: PoolModifyPositionTest
  let donateTest: PoolDonateTest
  let takeTest: PoolTakeTest
  let hooksMock: MockedContract
  let testHooksEmpty: EmptyTestHooks
  let tokens: { token0: TestERC20; token1: TestERC20; token2: TestERC20 }

  const fixture = async () => {
    const poolManagerFactory = await ethers.getContractFactory('PoolManager')
    const managerTestFactory = await ethers.getContractFactory('PoolManagerTest')
    const swapTestFactory = await ethers.getContractFactory('PoolSwapTest')
    const feeControllerTestFactory = await ethers.getContractFactory('ProtocolFeeControllerTest')
    const modifyPositionTestFactory = await ethers.getContractFactory('PoolModifyPositionTest')
    const donateTestFactory = await ethers.getContractFactory('PoolDonateTest')
    const takeTestFactory = await ethers.getContractFactory('PoolTakeTest')
    const hooksTestEmptyFactory = await ethers.getContractFactory('EmptyTestHooks')
    const tokens = await tokensFixture()
    const CONTROLLER_GAS_LIMIT = 50000
    const manager = (await poolManagerFactory.deploy(CONTROLLER_GAS_LIMIT)) as PoolManager

    // Deploy hooks to addresses with leading 1111 to enable all of them.
    const mockHooksAddress = '0xFF00000000000000000000000000000000000000'
    const testHooksEmptyAddress = '0xF000000000000000000000000000000000000000'

    const hookImplAddress = '0xFF00000000000000000000000000000000000001'
    setCode(hookImplAddress, 'EmptyTestHooks')
    hooksMock = await deployMockContract(hooksTestEmptyFactory.interface, mockHooksAddress, hookImplAddress)

    await hre.network.provider.send('hardhat_setCode', [
      testHooksEmptyAddress,
      (await hre.artifacts.readArtifact('EmptyTestHooks')).deployedBytecode,
    ])

    const testHooksEmpty: EmptyTestHooks = hooksTestEmptyFactory.attach(testHooksEmptyAddress) as EmptyTestHooks

    const result = {
      manager,
      lockTest: (await managerTestFactory.deploy()) as PoolManagerTest,
      swapTest: (await swapTestFactory.deploy(manager.address)) as PoolSwapTest,
      feeControllerTest: (await feeControllerTestFactory.deploy()) as ProtocolFeeControllerTest,
      modifyPositionTest: (await modifyPositionTestFactory.deploy(manager.address)) as PoolModifyPositionTest,
      donateTest: (await donateTestFactory.deploy(manager.address)) as PoolDonateTest,
      takeTest: (await takeTestFactory.deploy(manager.address)) as PoolTakeTest,
      tokens,
      hooksMock,
      testHooksEmpty,
    }

    for (const token of [tokens.token0, tokens.token1, tokens.token2]) {
      for (const spender of [result.swapTest, result.modifyPositionTest, result.donateTest, result.takeTest]) {
        await token.connect(wallet).approve(spender.address, constants.MaxUint256)
      }
    }

    return result
  }

  let loadFixture: ReturnType<typeof createFixtureLoader>
  before('create fixture loader', async () => {
    ;[wallet, other] = await (ethers as any).getSigners()

    loadFixture = createFixtureLoader([wallet, other])
  })

  beforeEach('deploy fixture', async () => {
    ;({
      manager,
      tokens,
      lockTest,
      modifyPositionTest,
      swapTest,
      feeControllerTest,
      donateTest,
      takeTest,
      hooksMock,
      testHooksEmpty,
    } = await loadFixture(fixture))
  })

  it('bytecode size', async () => {
    expect(((await waffle.provider.getCode(manager.address)).length - 2) / 2).to.matchSnapshot()
  })

  describe('#lock', () => {
    it('no-op lock is ok', async () => {
      await lockTest.lock(manager.address)
    })

    it('gas overhead of no-op lock', async () => {
      await snapshotGasCost(lockTest.lock(manager.address))
    })

    it('can be reentered', async () => {
      const reenterTest = (await (
        await ethers.getContractFactory('PoolManagerReentrancyTest')
      ).deploy()) as PoolManagerReentrancyTest

      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        encodeSqrtPriceX96(1, 1)
      )

      await modifyPositionTest.modifyPosition(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        {
          tickLower: 0,
          tickUpper: 60,
          liquidityDelta: 100,
        }
      )

      await expect(reenterTest.reenter(manager.address, tokens.token0.address, 3))
        .to.emit(reenterTest, 'LockAcquired')
        .withArgs(3)
        .to.emit(reenterTest, 'LockAcquired')
        .withArgs(2)
        .to.emit(reenterTest, 'LockAcquired')
        .withArgs(1)
    })
  })

  describe('#setProtocolFeeController', () => {
    it('allows the owner to set a fee controller', async () => {
      expect(await manager.protocolFeeController()).to.be.eq(ADDRESS_ZERO)
      await expect(manager.setProtocolFeeController(feeControllerTest.address)).to.emit(
        manager,
        'ProtocolFeeControllerUpdated'
      )
      expect(await manager.protocolFeeController()).to.be.eq(feeControllerTest.address)
    })
  })

  describe('#initialize', async () => {
    it('initializes a pool', async () => {
      const poolKey = {
        token0: tokens.token0.address,
        token1: tokens.token1.address,
        fee: FeeAmount.MEDIUM,
        tickSpacing: 60,
        hooks: ADDRESS_ZERO,
      }

      await manager.initialize(poolKey, encodeSqrtPriceX96(10, 1))

      const {
        slot0: { sqrtPriceX96, protocolFee },
      } = await manager.pools(getPoolId(poolKey))
      expect(sqrtPriceX96).to.eq(encodeSqrtPriceX96(10, 1))
      expect(protocolFee).to.eq(0)
    })

    it('initializes a pool with hooks', async () => {
      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: hooksMock.address,
        },
        encodeSqrtPriceX96(10, 1)
      )

      const {
        slot0: { sqrtPriceX96 },
      } = await manager.pools(
        getPoolId({
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: hooksMock.address,
        })
      )
      expect(sqrtPriceX96).to.eq(encodeSqrtPriceX96(10, 1))
    })

    it('can be initialized with MAX_TICK_SPACING', async () => {
      await expect(
        manager.initialize(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: MAX_TICK_SPACING,
            hooks: ADDRESS_ZERO,
          },
          encodeSqrtPriceX96(10, 1)
        )
      ).to.not.be.reverted
    })

    it('fails if hook does not return selector', async () => {
      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: testHooksEmpty.address,
        },
        encodeSqrtPriceX96(10, 1)
      )

      const {
        slot0: { sqrtPriceX96 },
      } = await manager.pools(
        getPoolId({
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: testHooksEmpty.address,
        })
      )
      expect(sqrtPriceX96).to.eq(encodeSqrtPriceX96(10, 1))
    })

    it('fails if tickSpacing is too large', async () => {
      await expect(
        manager.initialize(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: MAX_TICK_SPACING + 1,
            hooks: ADDRESS_ZERO,
          },
          encodeSqrtPriceX96(10, 1)
        )
      ).to.be.revertedWith('TickSpacingTooLarge()')
    })

    it('fails if tickSpacing is 0', async () => {
      await expect(
        manager.initialize(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: 0,
            hooks: ADDRESS_ZERO,
          },
          encodeSqrtPriceX96(10, 1)
        )
      ).to.be.revertedWith('TickSpacingTooSmall()')
    })

    it('fails if tickSpacing is negative', async () => {
      await expect(
        manager.initialize(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: -1,
            hooks: ADDRESS_ZERO,
          },
          encodeSqrtPriceX96(10, 1)
        )
      ).to.be.revertedWith('TickSpacingTooSmall()')
    })

    it('fetches a fee for new pools when theres a fee controller', async () => {
      expect(await manager.protocolFeeController()).to.be.eq(ADDRESS_ZERO)
      await manager.setProtocolFeeController(feeControllerTest.address)
      expect(await manager.protocolFeeController()).to.be.eq(feeControllerTest.address)

      const poolKey = {
        token0: tokens.token0.address,
        token1: tokens.token1.address,
        fee: FeeAmount.MEDIUM,
        tickSpacing: 60,
        hooks: ADDRESS_ZERO,
      }
      const poolProtocolFee = 4

      const poolID = getPoolId(poolKey)
      await feeControllerTest.setFeeForPool(poolID, poolProtocolFee)

      await manager.initialize(poolKey, encodeSqrtPriceX96(10, 1))

      const {
        slot0: { sqrtPriceX96, protocolFee },
      } = await manager.pools(getPoolId(poolKey))
      expect(sqrtPriceX96).to.eq(encodeSqrtPriceX96(10, 1))
      expect(protocolFee).to.eq(poolProtocolFee)
    })

    it('gas cost', async () => {
      await snapshotGasCost(
        manager.initialize(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: 60,
            hooks: ADDRESS_ZERO,
          },
          encodeSqrtPriceX96(10, 1)
        )
      )
    })
  })

  describe('#mint', async () => {
    it('reverts if pool not initialized', async () => {
      await expect(
        modifyPositionTest.modifyPosition(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: 60,
            hooks: ADDRESS_ZERO,
          },
          {
            tickLower: 0,
            tickUpper: 60,
            liquidityDelta: 100,
          }
        )
      ).to.be.revertedWith('I')
    })

    it('succeeds if pool is initialized', async () => {
      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        encodeSqrtPriceX96(1, 1)
      )

      await modifyPositionTest.modifyPosition(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        {
          tickLower: 0,
          tickUpper: 60,
          liquidityDelta: 100,
        }
      )
    })

    it('succeeds if pool is initialized and hook is provided', async () => {
      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: hooksMock.address,
        },
        encodeSqrtPriceX96(1, 1)
      )

      await modifyPositionTest.modifyPosition(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: hooksMock.address,
        },
        {
          tickLower: 0,
          tickUpper: 60,
          liquidityDelta: 100,
        }
      )

      const argsBeforeModify = [
        modifyPositionTest.address,
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: hooksMock.address,
        },
        {
          tickLower: 0,
          tickUpper: 60,
          liquidityDelta: 100,
        },
      ]
      const argsAfterModify = [...argsBeforeModify, { amount0: 1, amount1: 0 }]

      expect(await hooksMock.calledOnce('beforeModifyPosition')).to.be.true
      expect(await hooksMock.calledWith('beforeModifyPosition', argsBeforeModify)).to.be.true
      expect(await hooksMock.calledOnce('afterModifyPosition')).to.be.true
      expect(await hooksMock.calledWith('afterModifyPosition', argsAfterModify)).to.be.true

      expect(await hooksMock.called('beforeSwap')).to.be.false
      expect(await hooksMock.called('afterSwap')).to.be.false
    })

    it('gas cost', async () => {
      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        encodeSqrtPriceX96(1, 1)
      )

      await snapshotGasCost(
        modifyPositionTest.modifyPosition(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: 60,
            hooks: ADDRESS_ZERO,
          },
          {
            tickLower: 0,
            tickUpper: 60,
            liquidityDelta: 100,
          }
        )
      )
    })

    it('gas cost with hooks', async () => {
      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: testHooksEmpty.address,
        },
        encodeSqrtPriceX96(1, 1)
      )

      await snapshotGasCost(
        modifyPositionTest.modifyPosition(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: 60,
            hooks: testHooksEmpty.address,
          },
          {
            tickLower: 0,
            tickUpper: 60,
            liquidityDelta: 100,
          }
        )
      )
    })
  })

  describe('#swap', () => {
    it('fails if pool is not initialized', async () => {
      await expect(
        swapTest.swap(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: 60,
            hooks: ADDRESS_ZERO,
          },
          {
            amountSpecified: 100,
            sqrtPriceLimitX96: encodeSqrtPriceX96(1, 2),
            zeroForOne: true,
          },
          {
            withdrawTokens: true,
            settleUsingTransfer: true,
          }
        )
      ).to.be.revertedWith('I')
    })
    it('succeeds if pool is initialized', async () => {
      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        encodeSqrtPriceX96(1, 1)
      )
      await swapTest.swap(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        {
          amountSpecified: 100,
          sqrtPriceLimitX96: encodeSqrtPriceX96(1, 2),
          zeroForOne: true,
        },
        {
          withdrawTokens: false,
          settleUsingTransfer: false,
        }
      )
    })
    it('succeeds if pool is initialized and hook is provided', async () => {
      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: hooksMock.address,
        },
        encodeSqrtPriceX96(1, 1)
      )
      await swapTest.swap(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: hooksMock.address,
        },
        {
          amountSpecified: 100,
          sqrtPriceLimitX96: encodeSqrtPriceX96(1, 2),
          zeroForOne: true,
        },
        {
          withdrawTokens: false,
          settleUsingTransfer: false,
        }
      )

      const argsBeforeSwap = [
        swapTest.address,
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: hooksMock.address,
        },
        {
          amountSpecified: 100,
          sqrtPriceLimitX96: encodeSqrtPriceX96(1, 2),
          zeroForOne: true,
        },
      ]

      const argsAfterSwap = [...argsBeforeSwap, { amount0: 0, amount1: 0 }]

      expect(await hooksMock.calledOnce('beforeModifyPosition')).to.be.false
      expect(await hooksMock.calledOnce('afterModifyPosition')).to.be.false

      expect(await hooksMock.calledOnce('beforeSwap')).to.be.true
      expect(await hooksMock.calledOnce('afterSwap')).to.be.true
      expect(await hooksMock.calledWith('beforeSwap', argsBeforeSwap)).to.be.true
      expect(await hooksMock.calledWith('afterSwap', argsAfterSwap)).to.be.true
    })
    it('gas cost', async () => {
      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        encodeSqrtPriceX96(1, 1)
      )

      await swapTest.swap(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        {
          amountSpecified: 100,
          sqrtPriceLimitX96: encodeSqrtPriceX96(1, 2),
          zeroForOne: true,
        },
        {
          withdrawTokens: true,
          settleUsingTransfer: true,
        }
      )

      await snapshotGasCost(
        swapTest.swap(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: 60,
            hooks: ADDRESS_ZERO,
          },
          {
            amountSpecified: 100,
            sqrtPriceLimitX96: encodeSqrtPriceX96(1, 4),
            zeroForOne: true,
          },
          {
            withdrawTokens: false,
            settleUsingTransfer: false,
          }
        )
      )
    })
    it('gas cost with hooks', async () => {
      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: testHooksEmpty.address,
        },
        encodeSqrtPriceX96(1, 1)
      )

      await swapTest.swap(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: testHooksEmpty.address,
        },
        {
          amountSpecified: 100,
          sqrtPriceLimitX96: encodeSqrtPriceX96(1, 2),
          zeroForOne: true,
        },
        {
          withdrawTokens: true,
          settleUsingTransfer: true,
        }
      )

      await snapshotGasCost(
        swapTest.swap(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: 60,
            hooks: testHooksEmpty.address,
          },
          {
            amountSpecified: 100,
            sqrtPriceLimitX96: encodeSqrtPriceX96(1, 4),
            zeroForOne: true,
          },
          {
            withdrawTokens: true,
            settleUsingTransfer: true,
          }
        )
      )
    })
    it('mints erc1155s if the output token isnt taken', async () => {
      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        encodeSqrtPriceX96(1, 1)
      )
      await modifyPositionTest.modifyPosition(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        {
          tickLower: -120,
          tickUpper: 120,
          liquidityDelta: expandTo18Decimals(1),
        }
      )

      await expect(
        swapTest.swap(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: 60,
            hooks: ADDRESS_ZERO,
          },
          {
            amountSpecified: 100,
            sqrtPriceLimitX96: encodeSqrtPriceX96(1, 2),
            zeroForOne: true,
          },
          {
            withdrawTokens: false,
            settleUsingTransfer: true,
          }
        )
      ).to.emit(manager, 'TransferSingle')

      const erc1155Balance = await manager.balanceOf(wallet.address, tokens.token1.address)
      expect(erc1155Balance).to.be.eq(98)
    })
    it('uses 1155s as input from an account that owns them', async () => {
      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        encodeSqrtPriceX96(1, 1)
      )
      await modifyPositionTest.modifyPosition(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        {
          tickLower: -120,
          tickUpper: 120,
          liquidityDelta: expandTo18Decimals(1),
        }
      )

      // perform a swap and claim 1155s from it, so that they can be used in another trade
      await expect(
        swapTest.swap(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: 60,
            hooks: ADDRESS_ZERO,
          },
          {
            amountSpecified: 100,
            sqrtPriceLimitX96: encodeSqrtPriceX96(1, 2),
            zeroForOne: true,
          },
          {
            withdrawTokens: false,
            settleUsingTransfer: true,
          }
        )
      ).to.emit(manager, 'TransferSingle')

      let erc1155Balance = await manager.balanceOf(wallet.address, tokens.token1.address)
      expect(erc1155Balance).to.be.eq(98)

      // give permission for swapTest to burn the 1155s
      await manager.setApprovalForAll(swapTest.address, true)

      // now swap from token1 to token0 again, using 1155s as input tokens
      await expect(
        swapTest.swap(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: 60,
            hooks: ADDRESS_ZERO,
          },
          {
            amountSpecified: -25,
            sqrtPriceLimitX96: encodeSqrtPriceX96(4, 1),
            zeroForOne: false,
          },
          {
            withdrawTokens: true,
            settleUsingTransfer: false,
          }
        )
      ).to.emit(manager, 'TransferSingle')

      erc1155Balance = await manager.balanceOf(wallet.address, tokens.token1.address)
      expect(erc1155Balance).to.be.eq(71)
    })
    it('gas cost for swap against liquidity', async () => {
      await manager.initialize(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        encodeSqrtPriceX96(1, 1)
      )
      await modifyPositionTest.modifyPosition(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        {
          tickLower: -120,
          tickUpper: 120,
          liquidityDelta: expandTo18Decimals(1),
        }
      )

      await swapTest.swap(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        {
          amountSpecified: 100,
          sqrtPriceLimitX96: encodeSqrtPriceX96(1, 2),
          zeroForOne: true,
        },
        {
          withdrawTokens: true,
          settleUsingTransfer: true,
        }
      )

      await snapshotGasCost(
        swapTest.swap(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: FeeAmount.MEDIUM,
            tickSpacing: 60,
            hooks: ADDRESS_ZERO,
          },
          {
            amountSpecified: 100,
            sqrtPriceLimitX96: encodeSqrtPriceX96(1, 4),
            zeroForOne: true,
          },
          {
            withdrawTokens: true,
            settleUsingTransfer: true,
          }
        )
      )
    })
  })

  describe('#take', () => {
    it('fails if no liquidity', async () => {
      await tokens.token0.connect(wallet).transfer(ADDRESS_ZERO, constants.MaxUint256.div(2))
      await expect(
        takeTest.connect(wallet).take(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: 100,
            hooks: ADDRESS_ZERO,
            tickSpacing: 10,
          },
          100,
          0
        )
      ).to.be.reverted
    })

    it('fails for invalid tokens that dont return true on transfer', async () => {
      const tokenFactory = await ethers.getContractFactory('TestInvalidERC20')
      const invalidToken = (await tokenFactory.deploy(BigNumber.from(2).pow(255))) as TestERC20
      const token0Invalid = invalidToken.address.toLowerCase() < tokens.token0.address.toLowerCase()
      const key = {
        token0: token0Invalid ? invalidToken.address : tokens.token0.address,
        token1: token0Invalid ? tokens.token0.address : invalidToken.address,
        fee: 100,
        hooks: ADDRESS_ZERO,
        tickSpacing: 10,
      }
      await invalidToken.approve(modifyPositionTest.address, constants.MaxUint256)
      await manager.initialize(key, encodeSqrtPriceX96(1, 1))
      await modifyPositionTest.modifyPosition(key, {
        tickLower: -60,
        tickUpper: 60,
        liquidityDelta: 100,
      })

      await tokens.token0.connect(wallet).approve(takeTest.address, MaxUint128)
      await invalidToken.connect(wallet).approve(takeTest.address, MaxUint128)

      await expect(takeTest.connect(wallet).take(key, token0Invalid ? 1 : 0, token0Invalid ? 0 : 1)).to.be.reverted
      await expect(takeTest.connect(wallet).take(key, token0Invalid ? 0 : 1, token0Invalid ? 1 : 0)).to.not.be.reverted
    })

    it('succeeds if has liquidity', async () => {
      const key = {
        token0: tokens.token0.address,
        token1: tokens.token1.address,
        fee: 100,
        hooks: ADDRESS_ZERO,
        tickSpacing: 10,
      }
      await manager.initialize(key, encodeSqrtPriceX96(1, 1))
      await modifyPositionTest.modifyPosition(key, {
        tickLower: -60,
        tickUpper: 60,
        liquidityDelta: 100,
      })

      await tokens.token0.connect(wallet).approve(takeTest.address, MaxUint128)

      await expect(takeTest.connect(wallet).take(key, 1, 0)).to.be.not.be.reverted
      await expect(takeTest.connect(wallet).take(key, 0, 1)).to.be.not.be.reverted
    })
  })

  describe('#donate', () => {
    it('fails if not initialized', async () => {
      await expect(
        donateTest.donate(
          {
            token0: tokens.token0.address,
            token1: tokens.token1.address,
            fee: 100,
            hooks: ADDRESS_ZERO,
            tickSpacing: 10,
          },
          100,
          100
        )
      ).to.be.revertedWith('NoLiquidityToReceiveFees()')
    })

    it('fails if initialized with no liquidity', async () => {
      const key = {
        token0: tokens.token0.address,
        token1: tokens.token1.address,
        fee: 100,
        hooks: ADDRESS_ZERO,
        tickSpacing: 10,
      }
      await manager.initialize(key, encodeSqrtPriceX96(1, 1))
      await expect(donateTest.donate(key, 100, 100)).to.be.revertedWith('NoLiquidityToReceiveFees()')
    })

    it('succeeds if has liquidity', async () => {
      const key = {
        token0: tokens.token0.address,
        token1: tokens.token1.address,
        fee: 100,
        hooks: ADDRESS_ZERO,
        tickSpacing: 10,
      }
      await manager.initialize(key, encodeSqrtPriceX96(1, 1))
      await modifyPositionTest.modifyPosition(key, {
        tickLower: -60,
        tickUpper: 60,
        liquidityDelta: 100,
      })

      await expect(donateTest.donate(key, 100, 200)).to.be.not.be.reverted
      const { feeGrowthGlobal0X128, feeGrowthGlobal1X128 } = await manager.pools(getPoolId(key))
      expect(feeGrowthGlobal0X128).to.eq(BigNumber.from('340282366920938463463374607431768211456')) // 100 << 128 divided by liquidity
      expect(feeGrowthGlobal1X128).to.eq(BigNumber.from('680564733841876926926749214863536422912')) // 200 << 128 divided by liquidity
    })

    describe('hooks', () => {
      it('calls beforeDonate and afterDonate', async () => {
        const key = {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: 100,
          hooks: hooksMock.address,
          tickSpacing: 10,
        }
        await manager.initialize(key, encodeSqrtPriceX96(1, 1))
        await modifyPositionTest.modifyPosition(key, {
          tickLower: -60,
          tickUpper: 60,
          liquidityDelta: 100,
        })
        await donateTest.donate(key, 100, 200)
        expect(await hooksMock.calledWith('beforeDonate', [donateTest.address, key, 100, 200])).to.be.true
        expect(await hooksMock.calledWith('afterDonate', [donateTest.address, key, 100, 200])).to.be.true
      })
    })
  })

  describe('#setPoolProtocolFee', async () => {
    it('updates the protocol fee for an initialised pool', async () => {
      expect(await manager.protocolFeeController()).to.be.eq(ADDRESS_ZERO)

      const poolKey = {
        token0: tokens.token0.address,
        token1: tokens.token1.address,
        fee: FeeAmount.MEDIUM,
        tickSpacing: 60,
        hooks: ADDRESS_ZERO,
      }
      const poolID = getPoolId(poolKey)

      await manager.initialize(poolKey, encodeSqrtPriceX96(10, 1))

      var protocolFee: number
      ;({
        slot0: { protocolFee },
      } = await manager.pools(getPoolId(poolKey)))
      expect(protocolFee).to.eq(0)

      await manager.setProtocolFeeController(feeControllerTest.address)
      expect(await manager.protocolFeeController()).to.be.eq(feeControllerTest.address)
      const poolProtocolFee = 4
      await feeControllerTest.setFeeForPool(poolID, poolProtocolFee)

      await expect(manager.setPoolProtocolFee(poolKey)).to.emit(manager, 'PoolProtocolFeeUpdated')
      ;({
        slot0: { protocolFee },
      } = await manager.pools(getPoolId(poolKey)))
      expect(protocolFee).to.eq(poolProtocolFee)
    })
  })

  describe('#collectProtocolFees', async () => {
    beforeEach('set the fee controller, initialize a pool with protocol fee', async () => {
      const poolKey = {
        token0: tokens.token0.address,
        token1: tokens.token1.address,
        fee: FeeAmount.MEDIUM,
        tickSpacing: 60,
        hooks: ADDRESS_ZERO,
      }
      // set the controller, and set the pool's protocol fee
      await manager.setProtocolFeeController(feeControllerTest.address)
      expect(await manager.protocolFeeController()).to.be.eq(feeControllerTest.address)
      const poolProtocolFee = 68 // 0x 0100 0100
      const poolID = getPoolId(poolKey)
      await feeControllerTest.setFeeForPool(poolID, poolProtocolFee)

      // initialize the pool with the fee
      await manager.initialize(poolKey, encodeSqrtPriceX96(1, 1))
      const {
        slot0: { protocolFee },
      } = await manager.pools(getPoolId(poolKey))
      expect(protocolFee).to.eq(poolProtocolFee)

      // add liquidity around the initial price
      await modifyPositionTest.modifyPosition(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        {
          tickLower: -120,
          tickUpper: 120,
          liquidityDelta: expandTo18Decimals(10),
        }
      )
    })

    it('allows the owner to collect accumulated fees', async () => {
      await swapTest.swap(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        {
          amountSpecified: 10000,
          sqrtPriceLimitX96: encodeSqrtPriceX96(1, 2),
          zeroForOne: true,
        },
        {
          withdrawTokens: true,
          settleUsingTransfer: true,
        }
      )

      const expectedFees = 7
      expect(await manager.protocolFeesAccrued(tokens.token0.address)).to.be.eq(BigNumber.from(expectedFees))
      expect(await manager.protocolFeesAccrued(tokens.token1.address)).to.be.eq(BigNumber.from(0))

      // allows the owner to collect the fees
      const recipientBalanceBefore = await tokens.token0.balanceOf(other.address)
      const managerBalanceBefore = await tokens.token0.balanceOf(manager.address)

      // get the returned value, then actually execute
      const amount = await manager.callStatic.collectProtocolFees(other.address, tokens.token0.address, 7)
      await manager.collectProtocolFees(other.address, tokens.token0.address, expectedFees)

      const recipientBalanceAfter = await tokens.token0.balanceOf(other.address)
      const managerBalanceAfter = await tokens.token0.balanceOf(manager.address)

      expect(amount).to.be.eq(expectedFees)
      expect(recipientBalanceAfter).to.be.eq(recipientBalanceBefore.add(expectedFees))
      expect(managerBalanceAfter).to.be.eq(managerBalanceBefore.sub(expectedFees))

      expect(await manager.protocolFeesAccrued(tokens.token0.address)).to.be.eq(BigNumber.from(0))
    })

    it('returns all fees if 0 is provided', async () => {
      await swapTest.swap(
        {
          token0: tokens.token0.address,
          token1: tokens.token1.address,
          fee: FeeAmount.MEDIUM,
          tickSpacing: 60,
          hooks: ADDRESS_ZERO,
        },
        {
          amountSpecified: 10000,
          sqrtPriceLimitX96: encodeSqrtPriceX96(1, 2),
          zeroForOne: true,
        },
        {
          withdrawTokens: true,
          settleUsingTransfer: true,
        }
      )

      const expectedFees = 7
      expect(await manager.protocolFeesAccrued(tokens.token0.address)).to.be.eq(BigNumber.from(expectedFees))
      expect(await manager.protocolFeesAccrued(tokens.token1.address)).to.be.eq(BigNumber.from(0))

      // allows the owner to collect the fees
      const recipientBalanceBefore = await tokens.token0.balanceOf(other.address)
      const managerBalanceBefore = await tokens.token0.balanceOf(manager.address)

      // get the returned value, then actually execute
      const amount = await manager.callStatic.collectProtocolFees(other.address, tokens.token0.address, 0)
      await manager.collectProtocolFees(other.address, tokens.token0.address, 0)

      const recipientBalanceAfter = await tokens.token0.balanceOf(other.address)
      const managerBalanceAfter = await tokens.token0.balanceOf(manager.address)

      expect(amount).to.be.eq(expectedFees)
      expect(recipientBalanceAfter).to.be.eq(recipientBalanceBefore.add(expectedFees))
      expect(managerBalanceAfter).to.be.eq(managerBalanceBefore.sub(expectedFees))

      expect(await manager.protocolFeesAccrued(tokens.token0.address)).to.be.eq(BigNumber.from(0))
    })
  })
})