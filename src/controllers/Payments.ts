import { Types, Domain, Utils, BackendTypes, Helpers, DBModels, slugging, objHasProp } from '@ikomida/shared-backend'

export default class Payments {
  logger

  constructor(logger: Utils.Logger) {
    this.logger = logger
  }

  async cancelPayment(identity: Types.Classes.CUser, input: any) {
    const transaction = await Domain.SqlDB.sequelize.transaction()
    try {
      this.logger.info('---cancelPayment')
      const object: Types.Classes.CProcessPaymentResponse = Types.Classes.CProcessPaymentResponse.fromObject(input)
      const contractModel = await DBModels.ContractModel.findOne({
        where: {
          ikomidaID: identity.ikomidaID
        },
        transaction,
        include: [
          {
            model: DBModels.UserModel,
            required: true,
            where: {
              id: identity.id,
              role: {
                [Domain.SqlDB.Op.in]: [
                  BackendTypes.Roles.ADMIN,
                  BackendTypes.Roles.CLIENT,
                  BackendTypes.Roles.VENDOR,
                  BackendTypes.Roles.STAFF
                ]
              }
            }
          },
          {
            model: DBModels.VendorSettingsModel,
            required: false,
            include: [
              {
                model: DBModels.VendorPaymentGatewayModel,
                required: false
              }
            ]
          }
        ]
      })
      if (!contractModel) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_CANCEL_PAYMENT_INVALID_CONTRACT)
      }
      const vendorSettingsModel = contractModel?.vendorSettings
      if (!vendorSettingsModel) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_CANCEL_PAYMENT_VENDOR_SETTINGS)
      }
      if (!object?.id) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_CANCEL_PAYMENT_VENDOR_PAYMENT_SETTINGS)
      }
      const pagseguroHelper = new Helpers.PagseguroHelper(this.logger)
      const paymentGateway = await pagseguroHelper.configure(vendorSettingsModel?.vendorPaymentGateway)
      if (!paymentGateway) {
        throw new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_INVALID_VENDOR_PAYMENT_SETTINGS
        )
      }
      const userPaymentModels = await contractModel?.$get('userPayments', {
        transaction,
        where: {
          gateway: paymentGateway.constructor.name,
          id: object.id
        }
      })
      if (!userPaymentModels || userPaymentModels.length !== 1) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_CANCEL_PAYMENT_INVALID_USER_PAYMENT)
      }
      const userPaymentModel = userPaymentModels[0]
      const cancelPaymentObject = Types.Classes.Pagseguro.CPagSeguroCreateCharge.init(
        '',
        userPaymentModel.amount ?? 0,
        Types.Types.Pagseguro.TPagSeguroPaymentMethod.CREDIT_CARD,
        '',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        userPaymentModel.gatewayPaymentID
      )
      const cancelCharge = await paymentGateway?.cancelCharge(cancelPaymentObject)
      if (!cancelCharge) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_CANCEL_PAYMENT_RESPONSE_ERROR)
      }
      userPaymentModel.status = cancelCharge.status
      userPaymentModel.save({ transaction })
      await transaction.commit()
      return new Utils.Return(true, cancelCharge)
    } catch (exception: any) {
      await transaction.rollback()
      let error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PRODUCTS_SERVICE_NEW_PRODUCT_EXCEPTION, exception)
      if (exception instanceof Utils.iKomidaError) {
        error = exception
      }
      return error.logAndReturn(this.logger)
    }
  }
  async processPayment(identity: Types.Classes.CUser, input: any) {
    const transaction = await Domain.SqlDB.sequelize.transaction({
      isolationLevel: Domain.SqlDB.Transaction.ISOLATION_LEVELS.READ_UNCOMMITTED
    })
    try {
      const object: Types.Classes.CProcessPayment = Types.Classes.CProcessPayment.fromObject(input)
      this.logger.info('---processPayment')
      const contractModel = await DBModels.ContractModel.findOne({
        where: {
          ikomidaID: identity.ikomidaID
        },
        transaction,
        include: [
          {
            model: DBModels.UserModel,
            required: true,
            where: {
              id: identity.id,
              role: {
                [Domain.SqlDB.Op.in]: [
                  BackendTypes.Roles.ADMIN,
                  BackendTypes.Roles.CLIENT,
                  BackendTypes.Roles.VENDOR,
                  BackendTypes.Roles.STAFF
                ]
              }
            },
            include: [
              {
                model: DBModels.UserCreditCardModel,
                required: false,
                where: {
                  id: object?.paymentMethodID
                }
              }
            ]
          },
          {
            model: DBModels.VendorSettingsModel,
            required: false,
            include: [
              {
                model: DBModels.VendorPaymentGatewayModel,
                required: false
              }
            ]
          }
        ]
      })
      if (!contractModel) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_INVALID_CONTRACT)
      }
      const userModels = contractModel?.users
      if (!userModels || userModels.length !== 1) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_INVALID_USER)
      }
      const userModel = userModels[0]
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

      const userCreditCards = userModel?.userCreditCards
      if ((userCreditCards?.length ?? 0) !== 1) {
        throw new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_INVALID_PAYMENT_PAYMENT_METHOD
        )
      }
      const userCreditCard = userCreditCards?.[0]
      if (!userCreditCard?.type) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_ERROR)
      }
      const chargeObject: Types.Classes.Pagseguro.CPagSeguroCreateCharge =
        Types.Classes.Pagseguro.CPagSeguroCreateCharge.init(
          object.referenceId,
          object.amount,
          userCreditCard.type.pagseguro,
          slugging(vendorSettingsModel?.contractName),
          undefined,
          contractModel?.id,
          undefined,
          userCreditCard?.token,
          object?.description ?? `iKomida/${contractModel?.contractName}`
        )
      const chargeResult = await paymentGateway?.createCharge(chargeObject)
      if (!chargeResult) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_ERROR)
      }
      const userPaymentModel = await userModel.$create(
        'userPayment',
        {
          status: chargeResult.status,
          gateway: paymentGateway.constructor.name,
          brand: userCreditCard?.brand,
          firstDigits: userCreditCard?.firstDigits,
          lastDigits: userCreditCard?.lastDigits,
          gatewayPaymentID: chargeResult.id,
          orderID: chargeResult.reference,
          amount: chargeResult.amount,
          contractId: contractModel.id,
          userCreditCardId: userCreditCard.id
        },
        { transaction }
      )
      await transaction.commit()
      return new Utils.Return(true, Types.Classes.CProcessPaymentResponse.init(userPaymentModel.id))
    } catch (exception: any) {
      await transaction.rollback()
      let error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PRODUCTS_SERVICE_NEW_PRODUCT_EXCEPTION, exception)
      if (exception instanceof Utils.iKomidaError) {
        error = exception
      }
      return error.logAndReturn(this.logger)
    }
  }

  validatePayment(object: any) {
    return objHasProp(['number', 'expMonth', 'expYear', 'code', 'holder'], object)
  }
}
