import { Types, Domain, Utils, BackendTypes, Helpers, DBModels, slugging, objHasProp } from '@ikomida/shared-backend';

export default class Payments {
  logger;

  constructor(logger: Utils.Logger) {
    this.logger = logger;
  }

  async cancelPayment(identity: Types.Classes.CUser, input: any) {
    this.logger.info('---cancelPayment');
    const object: Types.Classes.CProcessPaymentResponse = Types.Classes.CProcessPaymentResponse.fromObject(input)
    const contractModel = await DBModels.ContractModel.findOne({
      where: {
        ikomidaID: identity.ikomidaID,
      },
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
                BackendTypes.Roles.STAFF,
              ],
            },
          },
        },
        {
          model: DBModels.VendorSettingsModel,
          required: false,
          include: [
            {
              model: DBModels.VendorPaymentGatewayModel,
              required: false,
            },
          ],
        },
      ],
    });
    if (!contractModel) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_CANCEL_PAYMENT_INVALID_CONTRACT);
      return error.logAndReturn(this.logger);
    }
    const vendorSettingsModel = contractModel?.vendorSettings;
    if (!vendorSettingsModel) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_CANCEL_PAYMENT_VENDOR_SETTINGS);
      return error.logAndReturn(this.logger);
    }
    if (!object?.id) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_CANCEL_PAYMENT_VENDOR_PAYMENT_SETTINGS);
      return error.logAndReturn(this.logger);
    }
    const pagseguroHelper = new Helpers.PagseguroHelper(this.logger);
    const paymentGateway = await pagseguroHelper.configure(vendorSettingsModel?.vendorPaymentGateway);
    if (!paymentGateway) {
      const error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_INVALID_VENDOR_PAYMENT_SETTINGS,
      );
      return error.logAndReturn(this.logger);
    }
    const userPaymentModels = await contractModel?.$get('userPayments', {
      where: {
        gateway: paymentGateway.constructor.name,
        id: object.id,
      },
    });
    if (!userPaymentModels || userPaymentModels.length !== 1) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_CANCEL_PAYMENT_INVALID_USER_PAYMENT);
      return error.logAndReturn(this.logger);
    }
    const userPaymentModel = userPaymentModels[0];
    const cancelPaymentObject = Types.Classes.Pagseguro.CPagSeguroCreateCharge.init('', userPaymentModel.amount ?? 0, Types.Types.Pagseguro.TPagSeguroPaymentMethod.CREDIT_CARD, '', undefined, undefined, undefined, undefined, undefined, undefined, userPaymentModel.gatewayPaymentID);
    const cancelCharge = await paymentGateway?.cancelCharge(cancelPaymentObject);
    if (!cancelCharge) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_CANCEL_PAYMENT_RESPONSE_ERROR);
      return error.logAndReturn(this.logger);
    }
    userPaymentModel.status = cancelCharge.status;
    userPaymentModel.save();
    return new Utils.Return(true, cancelCharge);
  }
  async processPayment(identity: Types.Classes.CUser, input: any) {
    const object: Types.Classes.CProcessPayment = Types.Classes.CProcessPayment.fromObject(input);
    this.logger.info('---processPayment');
    const contractModel = await DBModels.ContractModel.findOne({
      where: {
        ikomidaID: identity.ikomidaID,
      },
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
                BackendTypes.Roles.STAFF,
              ],
            },
          },
          include: [
            {
              model: DBModels.UserCreditCardModel,
              required: false,
              where: {
                id: object?.paymentMethodID,
              },
            },
          ],
        },
        {
          model: DBModels.VendorSettingsModel,
          required: false,
          include: [
            {
              model: DBModels.VendorPaymentGatewayModel,
              required: false,
            },
          ],
        },
      ],
    });
    if (!contractModel) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_INVALID_CONTRACT);
      return error.logAndReturn(this.logger);
    }
    const userModels = contractModel?.users;
    if (!userModels || userModels.length !== 1) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_INVALID_USER);
      return error.logAndReturn(this.logger);
    }
    const userModel = userModels[0];
    const vendorSettingsModel = contractModel?.vendorSettings;
    if (!vendorSettingsModel) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_INVALID_VENDOR_SETTINGS);
      return error.logAndReturn(this.logger);
    }
    const vendorPaymentGatewayModel = vendorSettingsModel?.vendorPaymentGateway;
    const pagseguroHelper = new Helpers.PagseguroHelper(this.logger);

    const paymentGateway = await pagseguroHelper.configure(vendorPaymentGatewayModel);
    if (!paymentGateway) {
      const error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_INVALID_VENDOR_PAYMENT_SETTINGS,
      );
      return error.logAndReturn(this.logger);
    }

    const userCreditCards = userModel?.userCreditCards;
    if ((userCreditCards?.length ?? 0) !== 1) {
      const error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_INVALID_PAYMENT_PAYMENT_METHOD,
      );
      return error.logAndReturn(this.logger);
    }
    const userCreditCard = userCreditCards?.[0];
    if (!userCreditCard?.type) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_ERROR);
      return error.logAndReturn(this.logger);
    }
    const chargeObject: Types.Classes.Pagseguro.CPagSeguroCreateCharge = Types.Classes.Pagseguro.CPagSeguroCreateCharge.init(
      object?.referenceId,
      object.amount,
      userCreditCard.type.pagseguro,
      slugging(vendorSettingsModel?.contractName),
      undefined,
      contractModel?.id,
      undefined,
      userCreditCard?.token,
      object?.description ?? `iKomida/${contractModel?.contractName}`,
    );
    const chargeResult = await paymentGateway?.createCharge(chargeObject);
    if (!chargeResult) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_ERROR);
      return error.logAndReturn(this.logger);
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
    });
    await contractModel.$add('userPayment', userPaymentModel);
    await userCreditCard?.$add('userPayment', userPaymentModel);
    return new Utils.Return(true, Types.Classes.CProcessPaymentResponse.init(userPaymentModel.id));
  }

  validatePayment(object: any) {
    return objHasProp(['number', 'expMonth', 'expYear', 'code', 'holder'], object);
  }
}
