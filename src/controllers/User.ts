import { Domain, Utils, Logics, Helpers, DBModels, objHasProp, slugging } from '@ikomida/shared-backend'
import { IiKomidaErrorModel } from '@ikomida/shared-backend/lib/src/Utils/iKomidaError'
import { Classes, Types } from '@ikomida/shared-types'

const supportedPaymentMethodTypes = [
  Types.TPaymentMethod.CASH_ON_DELIVERY,
  Types.TPaymentMethod.CREDIT_CARD_ON_DELIVERY,
  Types.TPaymentMethod.DEBT_CARD_ON_DELIVERY,
  Types.TPaymentMethod.CREDIT_CARD_ONLINE
]

export default class User {
  IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_GENERIC_ERROR: IiKomidaErrorModel = {
    code: 'IMPU0001',
    message: '{0}'
  }
  IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_ADD_COUPOM_MIN_VALUE: IiKomidaErrorModel = {
    code: 'IMPU0002',
    message: 'Este cupom é válido somente para compras acima de R$ {0}'
  }
  logger
  cashUUID = '00000000-0000-0000-0000-000000000000'

  constructor(logger: Utils.Logger) {
    this.logger = logger
  }

  async addCoupon(identity: Classes.CUser, input: any) {
    try {
      const payload: Classes.CCoupon = Classes.CCoupon.fromObject(input)
      const contractModel = await DBModels.ContractModel.findOne({
        where: {
          ikomidaID: identity.ikomidaID
        },
        include: [
          {
            model: DBModels.UserModel,
            required: true,
            where: {
              id: identity.id,
              role: {
                [Domain.SqlDB.Op.in]: [Types.TRoles.CLIENT]
              }
            }
          },
          {
            model: DBModels.CouponModel,
            required: false,
            where: {
              name: payload.name,
              quantity: {
                [Domain.SqlDB.Op.gt]: 0
              },
              validity: {
                [Domain.SqlDB.Op.gte]: new Date(Logics.DateTime.today())
              }
            }
          }
        ]
      })
      if (!contractModel) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_ADD_COUPON_INVALID_CONTRACT)
        return error.logAndReturn(this.logger)
      }
      const couponModels = contractModel.coupons
      if (
        (couponModels?.length ?? 0) !== 1 ||
        (payload.orderTypes && !couponModels?.[0].orderTypes?.includes(payload.orderTypes[0]))
      ) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_ADD_COUPON_NOT_FOUND)
        return error.logAndReturn(this.logger)
      }
      const couponModel = couponModels?.[0]
      if (couponModel && couponModel.minValue && couponModel.minValue > payload.minValue) {
        const error = new Utils.iKomidaError(
          this.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_ADD_COUPOM_MIN_VALUE,
          couponModel.minValue / 100
        )
        return error.logAndReturn(this.logger)
      }
      const coupon = Classes.CCoupon.init(
        couponModels?.[0]?.name ?? '',
        couponModels?.[0]?.value ?? 0,
        couponModels?.[0]?.minValue ?? 0,
        couponModels?.[0]?.valueType ?? Types.TDiscount.NO,
        undefined,
        undefined,
        undefined,
        undefined,
        couponModels?.[0]?.id
      )
      return new Classes.Return(true, coupon)
    } catch (exception: any) {
      this.logger.error(exception)
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_ADD_COUPON_ERROR)
      return error.logAndReturn(this.logger)
    }
  }

  async getPaymentMethods(identity: Classes.CUser) {
    try {
      const userPaymentModels = await this.getUserPaymentModels(identity)
      if ('success' in userPaymentModels) {
        return userPaymentModels
      }
      const userModel = userPaymentModels?.userModel
      const userCreditCardModels = userPaymentModels.userCreditCardModels
      const userPreferredPaymentMethodType = userModel?.paymentMethodType ?? Types.TPaymentMethod.CASH_ON_DELIVERY
      const isOnlineCreditCard = userPreferredPaymentMethodType === Types.TPaymentMethod.CREDIT_CARD_ONLINE
      const paymentMethods =
        userCreditCardModels?.map(paymentMethodModel => {
          return Classes.CPaymentMethod.init(
            paymentMethodModel?.type ?? Types.TPaymentMethod.CASH_ON_DELIVERY,
            paymentMethodModel?.brand ?? '-',
            paymentMethodModel?.lastDigits ?? '',
            paymentMethodModel?.firstDigits,
            isOnlineCreditCard && paymentMethodModel?.selected,
            paymentMethodModel?.createdAt,
            paymentMethodModel?.id
          )
        }) ?? []
      for (const supportedPaymentMethodType of supportedPaymentMethodTypes) {
        if (supportedPaymentMethodType !== Types.TPaymentMethod.CREDIT_CARD_ONLINE) {
          paymentMethods?.push(
            Classes.CPaymentMethod.init(
              supportedPaymentMethodType,
              '',
              '',
              undefined,
              userPreferredPaymentMethodType === supportedPaymentMethodType,
              userModel?.createdAt,
              supportedPaymentMethodType.id
            )
          )
        }
      }
      return new Classes.Return(true, paymentMethods)
    } catch (exception: any) {
      const error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_EXCEPTION,
        exception
      )
      return error.logAndReturn(this.logger)
    }
  }

  async newCreditCard(identity: Classes.CUser, input: any) {
    this.logger.info('---newCreditCard:')
    try {
      const payload: Classes.CCreditCardRequest = Classes.CCreditCardRequest.fromObject(input)
      if (!payload.validate() || !this.validatenewCreditCard(payload)) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_MISSING_DATA)
      }
      const userPaymentModels = await this.getUserPaymentModels(identity)
      if ('success' in userPaymentModels) {
        return userPaymentModels
      }
      const contractModel = userPaymentModels.contractModel
      const userModel = userPaymentModels.userModel
      const userCreditCardModels = userPaymentModels.userCreditCardModels
      const vendorSettingsModel = contractModel?.vendorSettings
      if (!vendorSettingsModel) {
        throw new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_INVALID_VENDOR_SETTINGS
        )
      }
      const vendorPaymentGatewayModel = vendorSettingsModel?.vendorPaymentGateway
      const pagseguroHelper = new Helpers.PagseguroHelper(this.logger)
      const paymentGateway = await pagseguroHelper.configure(vendorPaymentGatewayModel)
      if (!paymentGateway) {
        throw new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_INVALID_VENDOR_PAYMENT_SETTINGS
        )
      }
      const createChargeObject = Classes.Pagseguro.CPagSeguroCreateCharge.init(
        identity.ikomidaID ?? '',
        Logics.Finances.random(100, 199),
        Types.Pagseguro.TPagSeguroPaymentMethod.CREDIT_CARD,
        slugging(vendorSettingsModel?.contractName),
        Classes.Pagseguro.CPagseguroCreateChargeConfig.fromObject({
          host: pagseguroHelper?.host,
          uri: pagseguroHelper?.uri
        }),
        contractModel?.id,
        Classes.Pagseguro.CPagSeguroCard.init(
          Classes.Pagseguro.CPagSeguroCardHolder.fromObject({ name: payload.holder }),
          Number(payload.number),
          undefined,
          Number(payload.validity?.substring(0, 2)),
          Number(`20${payload.validity?.substring(2, 4)}`),
          payload.code,
          true
        ),
        undefined,
        'Validar cartão de crédito - iKomida'
      )
      const chargeResult = await paymentGateway?.createCharge(createChargeObject, true)
      if (!chargeResult) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_ERROR)
      }
      if (chargeResult instanceof Types.TPagSeguroPaymentStatus) {
        throw new Utils.iKomidaError(
          this.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_GENERIC_ERROR,
          chargeResult.description
        )
      }
      if (!(chargeResult instanceof Classes.Pagseguro.CChargeResponse)) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_ERROR)
      }
      const userPaymentModel = await userModel?.$create('userPayment', {
        status: chargeResult.status,
        gateway: paymentGateway.constructor.name,
        brand: chargeResult?.brand,
        firstDigits: chargeResult?.firstDigits,
        lastDigits: chargeResult?.lastDigits,
        gatewayPaymentID: chargeResult.id,
        amount: chargeResult.amount,
        contractId: contractModel.id
      })
      try {
        const paymentPayload = new Classes.CAMQPPayload<string>({
          method: 'cancelPayment',
          object: userPaymentModel?.id
        })
        const amqp = new Domain.RabbitMQ(this.logger)
        await amqp?.publish(Domain.RabbitMQ.PAYMENT_QUEUE, paymentPayload)
        await amqp?.close()
      } catch (exception: any) {
        this.logger.error(exception)
        const error = new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_CANT_ADD_TO_CANCEL_QUEUE
        )
        error.log(this.logger)
      }

      for (const userCreditCardModel of userCreditCardModels ?? []) {
        await userCreditCardModel?.update({
          selected: false
        })
      }
      const userCreditCard = await userModel?.$create('userCreditCard', {
        type: Types.TPaymentMethod.CREDIT_CARD_ONLINE,
        brand: chargeResult?.brand,
        firstDigits: chargeResult?.firstDigits,
        lastDigits: chargeResult?.lastDigits,
        token: chargeResult?.cardId,
        contractId: contractModel.id
      })
      if (userPaymentModel) {
        await userCreditCard?.$add('userPayment', userPaymentModel)
      }
      if (userModel) {
        userModel.paymentMethodType = Types.TPaymentMethod.CREDIT_CARD_ONLINE
      }
      await userModel?.save()
      return new Classes.Return(true)
    } catch (exception: any) {
      let error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_EXCEPTION,
        exception
      )
      if (error instanceof Utils.iKomidaError) {
        error = exception
      }
      return error.logAndReturn(this.logger)
    }
  }

  async updatePaymentMethod(identity: Classes.CUser, id?: string) {
    try {
      const selectedrPaymentMethod: Types.TPaymentMethod | null = Types.TPaymentMethod.valueOf(id)
      if (
        selectedrPaymentMethod &&
        !supportedPaymentMethodTypes.includes(selectedrPaymentMethod) &&
        !Logics.Validations.validateUUID(id)
      ) {
        const error = new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_MISSING_DATA
        )
        return error.logAndReturn(this.logger)
      }
      const userPaymentModels = await this.getUserPaymentModels(identity)
      if ('success' in userPaymentModels) {
        return userPaymentModels
      }
      const userModel = userPaymentModels.userModel
      const userCreditCardModels = userPaymentModels.userCreditCardModels ?? []
      for (const userCreditCardModel of userCreditCardModels) {
        const selected = userCreditCardModel?.id === id
        if (userCreditCardModel.selected !== selected) {
          await userCreditCardModel?.update({
            selected
          })
        }
      }
      if (userModel) {
        userModel.paymentMethodType = !(
          selectedrPaymentMethod && supportedPaymentMethodTypes.includes(selectedrPaymentMethod)
        )
          ? Types.TPaymentMethod.CREDIT_CARD_ONLINE
          : selectedrPaymentMethod
      }
      await userModel?.save()
      return new Classes.Return(true)
    } catch (exception: any) {
      const error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_EXCEPTION,
        exception
      )
      return error.logAndReturn(this.logger)
    }
  }

  async removePaymentMethod(identity: Classes.CUser, id?: string) {
    try {
      const selectedrPaymentMethod: Types.TPaymentMethod | null = Types.TPaymentMethod.valueOf(id)
      if (
        selectedrPaymentMethod &&
        !supportedPaymentMethodTypes.includes(selectedrPaymentMethod) &&
        !Logics.Validations.validateUUID(id)
      ) {
        const error = new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_MISSING_DATA
        )
        return error.logAndReturn(this.logger)
      }
      const userPaymentModels = await this.getUserPaymentModels(identity)
      if ('success' in userPaymentModels) {
        return userPaymentModels
      }
      const userModel = userPaymentModels.userModel
      let userCreditCardModels = userPaymentModels.userCreditCardModels ?? []
      let setNextSelected = false
      for (const userCreditCardModel of userCreditCardModels) {
        if (userCreditCardModel?.id === id) {
          setNextSelected = userCreditCardModel?.selected ?? false
          await userCreditCardModel?.destroy()
          break
        }
      }
      if (setNextSelected) {
        for (const userCreditCardModel of userCreditCardModels) {
          if (userCreditCardModel?.id !== id && setNextSelected) {
            userCreditCardModel.selected = true
            await userCreditCardModel?.save()
            setNextSelected = false
            break
          }
        }
        userCreditCardModels = userCreditCardModels?.filter(item => !item?.deletedAt)
        if (
          Types.TPaymentMethod.CREDIT_CARD_ONLINE === userModel?.paymentMethodType &&
          (userCreditCardModels?.length ?? 0) === 0
        ) {
          userModel.paymentMethodType = Types.TPaymentMethod.CASH_ON_DELIVERY
          await userModel?.save()
        }
      }
      return new Classes.Return(true)
    } catch (exception: any) {
      const error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_EXCEPTION,
        exception
      )
      return error.logAndReturn(this.logger)
    }
  }

  async getUserPaymentModels(identity: Classes.CUser) {
    const contractModel = await DBModels.ContractModel.findOne({
      where: {
        ikomidaID: identity.ikomidaID
      },
      include: [
        {
          model: DBModels.UserModel,
          required: true,
          where: {
            id: identity.id,
            role: {
              [Domain.SqlDB.Op.in]: [Types.TRoles.CLIENT]
            }
          },
          include: [
            {
              model: DBModels.UserCreditCardModel,
              required: false,
              order: [['createdAt', 'DESC']]
            }
          ]
        },
        {
          model: DBModels.VendorSettingsModel,
          include: [DBModels.VendorPaymentGatewayModel],
          required: false
        }
      ]
    })
    if (!contractModel) {
      const error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_INVALID_CONTRACT
      )
      return error.logAndReturn(this.logger)
    }
    if ((contractModel?.users?.length ?? 0) !== 1) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_INVALID_USER)
      return error.logAndReturn(this.logger)
    }
    const userModel = contractModel?.users?.[0]
    return {
      contractModel,
      userModel,
      userCreditCardModels: userModel?.userCreditCards?.sort((i1, i2) => i2?.createdAt - i1?.createdAt)
    }
  }
  validatenewCreditCard(object: any) {
    return objHasProp(['number', 'validity', 'code', 'holder'], object)
  }
}
