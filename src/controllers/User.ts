import {
  Domain,
  Utils,
  BackendTypes,
  Logics,
  Helpers,
  Types,
  DBModels,
  objHasProp,
  slugging,
} from '@ikomida/shared-backend';

const supportedPaymentMethodTypes = [
  Types.Types.TPaymentMethod.CASH_ON_DELIVERY,
  Types.Types.TPaymentMethod.CREDIT_CARD_ON_DELIVERY,
  Types.Types.TPaymentMethod.DEBT_CARD_ON_DELIVERY,
  Types.Types.TPaymentMethod.CREDIT_CARD_ONLINE,
];

export default class User {
  logger;
  cashUUID = '00000000-0000-0000-0000-000000000000';

  constructor(logger: Utils.Logger) {
    this.logger = logger;
  }

  async addCoupon(identity: Types.Classes.CUser, name: string) {
    try {
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
                [Domain.SqlDB.Op.in]: [BackendTypes.Roles.CLIENT],
              },
            },
          },
          {
            model: DBModels.CouponModel,
            required: false,
            where: {
              name,
              quantity: {
                [Domain.SqlDB.Op.gt]: 0,
              },
              validity: {
                [Domain.SqlDB.Op.gte]: new Date(Logics.DateTime.today()),
              },
            },
          },
        ],
      });
      if (!contractModel) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_ADD_COUPON_INVALID_CONTRACT);
        return error.logAndReturn(this.logger);
      }
      this.logger.info(contractModel);
      const couponModels = contractModel.coupons;
      if ((couponModels?.length ?? 0) !== 1) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_ADD_COUPON_NOT_FOUND);
        return error.logAndReturn(this.logger);
      }
      const coupon = Types.Classes.CCoupon.init(couponModels?.[0]?.name ?? '', couponModels?.[0]?.value ?? 0, couponModels?.[0]?.valueType ?? Types.Types.TDiscount.NO, undefined, undefined, undefined, couponModels?.[0]?.id);
      return new Utils.Return(true, coupon);
    } catch (exception: any) {
      console.error(exception);
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_ADD_COUPON_ERROR);
      return error.logAndReturn(this.logger);
    }
  }

  async getPaymentMethods(identity: Types.Classes.CUser) {
    try {
      const userPaymentModels = await this.getUserPaymentModels(identity);
      if ('success' in userPaymentModels) {
        return userPaymentModels;
      }
      const userModel = userPaymentModels?.userModel;
      const userCreditCardModels = userPaymentModels.userCreditCardModels;
      const userPreferredPaymentMethodType =
        userModel?.paymentMethodType ?? Types.Types.TPaymentMethod.CASH_ON_DELIVERY;
      const isOnlineCreditCard = userPreferredPaymentMethodType === Types.Types.TPaymentMethod.CREDIT_CARD_ONLINE;
      const paymentMethods =
        userCreditCardModels?.map((paymentMethodModel) => {
          return Types.Classes.CPaymentMethod.init(
            paymentMethodModel?.type ?? Types.Types.TPaymentMethod.CASH_ON_DELIVERY,
            paymentMethodModel?.brand ?? '-',
            paymentMethodModel?.lastDigits ?? 0,
            isOnlineCreditCard && paymentMethodModel?.selected,
            undefined,
            paymentMethodModel?.createdAt,
            paymentMethodModel?.id,
          );
        }) ?? [];
      for (const supportedPaymentMethodType of supportedPaymentMethodTypes) {
        if (supportedPaymentMethodType !== Types.Types.TPaymentMethod.CREDIT_CARD_ONLINE) {
          paymentMethods?.push(
            Types.Classes.CPaymentMethod.init(
              supportedPaymentMethodType,
              '',
              0,
              userPreferredPaymentMethodType === supportedPaymentMethodType,
              undefined,
              userModel?.createdAt,
              supportedPaymentMethodType.id,
            ),
          );
        }
      }
      return new Utils.Return(true, paymentMethods);
    } catch (exception: any) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_EXCEPTION, exception);
      return error.logAndReturn(this.logger);
    }
  }

  async newCreditCard(identity: Types.Classes.CUser, input: any) {
    this.logger.info('---newCreditCard:');
    try {
      const payload: Types.Classes.CCreditCardRequest = Types.Classes.CCreditCardRequest.fromObject(input)
      if (!payload.validate() || !this.validatenewCreditCard(payload)) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_MISSING_DATA);
        return error.logAndReturn(this.logger);
      }
      const userPaymentModels = await this.getUserPaymentModels(identity);
      if ('success' in userPaymentModels) {
        return userPaymentModels;
      }
      const contractModel = userPaymentModels.contractModel;
      const userModel = userPaymentModels.userModel;
      const userCreditCardModels = userPaymentModels.userCreditCardModels;
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
      const createChargeObject = Types.Classes.Pagseguro.CPagSeguroCreateCharge.init(identity.ikomidaID ?? '', Logics.Finances.random(100, 199), Types.Types.Pagseguro.TPagSeguroPaymentMethod.CREDIT_CARD, slugging(vendorSettingsModel?.contractName), Types.Classes.Pagseguro.CPagseguroCreateChargeConfig.fromObject({
        host: pagseguroHelper?.host,
        uri: pagseguroHelper?.uri,
      }), contractModel?.id,
        Types.Classes.Pagseguro.CPagSeguroCard.init(Types.Classes.Pagseguro.CPagSeguroCardHolder.fromObject({ name: payload.holder }), Number(payload.number), undefined, Number(payload.validity?.substring(0, 2)), Number(`20${payload.validity?.substring(2, 4)}`), payload.code, true), undefined, 'Validar cartão de crédito - iKomida');
      const chargeResult = await paymentGateway?.createCharge(createChargeObject, true);
      if (!chargeResult) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_CREATE_CHARGE_ERROR);
        return error.logAndReturn(this.logger);
      }
      const userPaymentModel = await userModel?.$create('userPayment', {
        status: chargeResult.status,
        gateway: paymentGateway.constructor.name,
        brand: chargeResult?.brand,
        firstDigits: chargeResult?.firstDigits,
        lastDigits: chargeResult?.lastDigits,
        gatewayPaymentID: chargeResult.id,
        amount: chargeResult.amount,
      });
      if (userPaymentModel) {
        await contractModel.$add('userPayment', userPaymentModel);
      }

      for (const userCreditCardModel of userCreditCardModels ?? []) {
        await userCreditCardModel?.update({
          selected: false,
        });
      }
      const userCreditCard = await userModel?.$create('userCreditCard', {
        type: Types.Types.TPaymentMethod.CREDIT_CARD_ONLINE,
        brand: chargeResult?.brand,
        firstDigits: chargeResult?.firstDigits,
        lastDigits: chargeResult?.lastDigits,
        token: chargeResult?.cardId,
      });
      if (userPaymentModel) {
        await userCreditCard?.$add('userPayment', userPaymentModel);
      }
      if (userCreditCard) {
        await contractModel.$add('userCreditCard', userCreditCard);
      }
      if (userModel) {
        userModel.paymentMethodType = Types.Types.TPaymentMethod.CREDIT_CARD_ONLINE;
      }
      await userModel?.save();
      try {
        const paymentPayload = new Types.Classes.CAMQPPayload<string>({
          method: 'cancelPayment',
          object: userPaymentModel?.id,
        });
        const amqp = new Domain.RabbitMQ(this.logger);
        await amqp?.publish(Domain.RabbitMQ.PAYMENT_QUEUE, paymentPayload);
        await amqp?.close();
      } catch (exception: any) {
        console.error(exception);
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_CANT_ADD_TO_CANCEL_QUEUE);
        error.log(this.logger);
      }
      return new Utils.Return(true);
    } catch (exception: any) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_EXCEPTION, exception);
      return error.logAndReturn(this.logger);
    }
  }

  async updatePaymentMethod(identity: Types.Classes.CUser, id?: string) {
    try {
      const selectedrPaymentMethod: Types.Types.TPaymentMethod | null = Types.Types.TPaymentMethod.valueOf(id);
      if (
        selectedrPaymentMethod &&
        !supportedPaymentMethodTypes.includes(selectedrPaymentMethod) &&
        !Logics.Validations.validateUUID(id)
      ) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_MISSING_DATA);
        return error.logAndReturn(this.logger);
      }
      const userPaymentModels = await this.getUserPaymentModels(identity);
      if ('success' in userPaymentModels) {
        return userPaymentModels;
      }
      const userModel = userPaymentModels.userModel;
      const userCreditCardModels = userPaymentModels.userCreditCardModels ?? [];
      for (const userCreditCardModel of userCreditCardModels) {
        const selected = userCreditCardModel?.id === id;
        if (userCreditCardModel.selected !== selected) {
          await userCreditCardModel?.update({
            selected,
          });
        }
      }
      if (userModel) {
        userModel.paymentMethodType = !(
          selectedrPaymentMethod && supportedPaymentMethodTypes.includes(selectedrPaymentMethod)
        )
          ? Types.Types.TPaymentMethod.CREDIT_CARD_ONLINE
          : selectedrPaymentMethod;
      }
      await userModel?.save();
      return new Utils.Return(true);
    } catch (exception: any) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_EXCEPTION, exception);
      return error.logAndReturn(this.logger);
    }
  }

  async removePaymentMethod(identity: Types.Classes.CUser, id?: string) {
    try {
      const selectedrPaymentMethod: Types.Types.TPaymentMethod | null = Types.Types.TPaymentMethod.valueOf(id);
      if (
        selectedrPaymentMethod &&
        !supportedPaymentMethodTypes.includes(selectedrPaymentMethod) &&
        !Logics.Validations.validateUUID(id)
      ) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_MISSING_DATA);
        return error.logAndReturn(this.logger);
      }
      const userPaymentModels = await this.getUserPaymentModels(identity);
      if ('success' in userPaymentModels) {
        return userPaymentModels;
      }
      const userModel = userPaymentModels.userModel;
      let userCreditCardModels = userPaymentModels.userCreditCardModels ?? [];
      let setNextSelected = false;
      for (const userCreditCardModel of userCreditCardModels) {
        if (userCreditCardModel?.id === id) {
          setNextSelected = userCreditCardModel?.selected ?? false;
          await userCreditCardModel?.destroy();
          break;
        }
      }
      if (setNextSelected) {
        for (const userCreditCardModel of userCreditCardModels) {
          if (userCreditCardModel?.id !== id && setNextSelected) {
            userCreditCardModel.selected = true;
            await userCreditCardModel?.save();
            setNextSelected = false;
            break;
          }
        }
        userCreditCardModels = userCreditCardModels?.filter((item) => !item?.deletedAt);
        if (
          Types.Types.TPaymentMethod.CREDIT_CARD_ONLINE === userModel?.paymentMethodType &&
          (userCreditCardModels?.length ?? 0) === 0
        ) {
          userModel.paymentMethodType = Types.Types.TPaymentMethod.CASH_ON_DELIVERY;
          await userModel?.save();
        }
      }
      return new Utils.Return(true);
    } catch (exception: any) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_EXCEPTION, exception);
      return error.logAndReturn(this.logger);
    }
  }

  async getUserPaymentModels(identity: Types.Classes.CUser) {
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
              [Domain.SqlDB.Op.in]: [BackendTypes.Roles.CLIENT],
            },
          },
          include: [
            {
              model: DBModels.UserCreditCardModel,
              required: false,
              order: [['createdAt', 'DESC']],
            },
          ],
        },
        {
          model: DBModels.VendorSettingsModel,
          include: [DBModels.VendorPaymentGatewayModel],
          required: false,
        },
      ],
    });
    if (!contractModel) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_INVALID_CONTRACT);
      return error.logAndReturn(this.logger);
    }
    if ((contractModel?.users?.length ?? 0) !== 1) {
      const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_INVALID_USER);
      return error.logAndReturn(this.logger);
    }
    const userModel = contractModel?.users?.[0];
    return {
      contractModel,
      userModel,
      userCreditCardModels: userModel?.userCreditCards?.sort((i1, i2) => i2?.createdAt - i1?.createdAt),
    };
  }
  validatenewCreditCard(object: any) {
    return objHasProp(['number', 'validity', 'code', 'holder'], object);
  }
}
