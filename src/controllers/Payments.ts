import { Domain, Utils, Helpers, DBModels, slugging, objHasProp, BackendTypes } from '@ikomida/shared-backend'
import { IiKomidaErrorModel } from '@ikomida/shared-backend/lib/src/Utils/iKomidaError'
import { Classes, Types } from '@ikomida/shared-types'
import User from './User.js'

export default class Payments {
  IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_GENERIC_ERROR: IiKomidaErrorModel = {
    code: 'IMPP0001',
    message: '{0}'
  }
  logger

  constructor(logger: Utils.Logger) {
    this.logger = logger
  }

  async cancelPayment(identity: Classes.CUser, input: any) {
    try {
      this.logger.info('---cancelPayment')
      const object: Classes.CProcessPaymentResponse = Classes.CProcessPaymentResponse.fromObject(input)
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
                [Domain.SqlDB.Op.in]: [Types.TRoles.ADMIN, Types.TRoles.CLIENT, Types.TRoles.VENDOR, Types.TRoles.STAFF]
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
        where: {
          gateway: paymentGateway.constructor.name,
          id: object.id
        }
      })
      if (!userPaymentModels || userPaymentModels.length !== 1) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_CANCEL_PAYMENT_INVALID_USER_PAYMENT)
      }
      const userPaymentModel = userPaymentModels[0]
      const cancelPaymentObject = Classes.Pagseguro.CPagSeguroCreateCharge.init(
        '',
        userPaymentModel.amount ?? 0,
        Types.Pagseguro.TPagSeguroPaymentMethod.CREDIT_CARD,
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
      if (cancelCharge instanceof Types.TPagSeguroPaymentStatus) {
        throw new Utils.iKomidaError(
          this.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_GENERIC_ERROR,
          cancelCharge.description
        )
      }
      if (!(cancelCharge instanceof Classes.Pagseguro.CChargeResponse)) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_ERROR)
      }
      userPaymentModel.status = cancelCharge.status
      await userPaymentModel.save()
      return new Classes.Return(true, cancelCharge)
    } catch (exception: any) {
      let error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PRODUCTS_SERVICE_NEW_PRODUCT_EXCEPTION, exception)
      if (exception instanceof Utils.iKomidaError) {
        error = exception
      }
      return error.logAndReturn(this.logger)
    }
  }
  async processPayment(identity: Classes.CUser, input: any, user: User) {
    try {
      const object: Classes.CProcessPayment = Classes.CProcessPayment.fromObject(input)
      this.logger.info('---processPayment')
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
                [Domain.SqlDB.Op.in]: [Types.TRoles.ADMIN, Types.TRoles.CLIENT, Types.TRoles.VENDOR, Types.TRoles.STAFF]
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
      const chargeObject: Classes.Pagseguro.CPagSeguroCreateCharge = Classes.Pagseguro.CPagSeguroCreateCharge.init(
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
      if (chargeResult instanceof Types.TPagSeguroPaymentStatus) {
        throw new Utils.iKomidaError(
          this.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_GENERIC_ERROR,
          chargeResult.description
        )
      }
      if (chargeResult instanceof BackendTypes.TPagseguroCharge) {
        if (chargeResult === BackendTypes.TPagseguroCharge.INVALID_CARD_ID) {
          await user.removePaymentMethod(identity, userCreditCard.id)
        }
        throw new Utils.iKomidaError(
          this.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_GENERIC_ERROR,
          chargeResult.description
        )
      }
      if (!(chargeResult instanceof Classes.Pagseguro.CChargeResponse)) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_ERROR)
      }
      const userPaymentModel = await userModel.$create('userPayment', {
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
      })
      return new Classes.Return(true, Classes.CProcessPaymentResponse.init(userPaymentModel.id))
    } catch (exception: any) {
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
