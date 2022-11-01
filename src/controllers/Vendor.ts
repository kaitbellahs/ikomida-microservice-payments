import { Domain, Utils, BackendTypes, Logics, Types, DBModels } from '@ikomida/shared-backend'

export default class Vendor {
  logger
  limit = 10

  constructor(logger: Utils.Logger) {
    this.logger = logger
  }

  async newCoupon(identity: Types.Classes.CUser, input: any) {
    try {
      const coupon: Types.Classes.CCoupon = Types.Classes.CCoupon.fromObject(input)
      const role = BackendTypes.Roles.valueOf(identity.role)
      if (!coupon.validate() || !role || ![BackendTypes.Roles.VENDOR, BackendTypes.Roles.STAFF].includes(role)) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_COUPON_VENDOR)
        return error.logAndReturn(this.logger)
      }
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
                [Domain.SqlDB.Op.in]: [BackendTypes.Roles.ADMIN, BackendTypes.Roles.VENDOR, BackendTypes.Roles.STAFF]
              }
            }
          },
          {
            model: DBModels.VendorSettingsModel,
            required: false
          },
          {
            model: DBModels.PlanModel,
            required: false
          },
          {
            model: DBModels.CouponModel,
            required: false
          }
        ]
      })
      if (!contractModel) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_COUPON_INVALID_CONTRACT)
        return error.logAndReturn(this.logger)
      }
      const couponsLimit = contractModel?.plan?.coupons ?? -1
      if (couponsLimit !== -1 && (contractModel?.coupons?.length ?? 0) >= couponsLimit) {
        const error = new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_COUPON_LIMIT_EXCEEDED,
          couponsLimit
        )
        return error.logAndReturn(this.logger)
      }
      await contractModel.$create('coupon', {
        name: coupon.name,
        validity: coupon.validity,
        value: Logics.Finances.toFinanceNumber(coupon.value),
        minValue: Logics.Finances.toFinanceNumber(coupon.minValue),
        valueType: coupon.valueType,
        quantity: coupon.quantity ? coupon.quantity : 0
      })
      return new Utils.Return(true)
    } catch (e) {
      this.logger.error(e)
    }
    return new Utils.Return(false)
  }

  async removeCoupon(identity: Types.Classes.CUser, id?: string) {
    try {
      const role = BackendTypes.Roles.valueOf(identity.role)
      if (!role || ![BackendTypes.Roles.VENDOR, BackendTypes.Roles.ADMIN].includes(role)) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_REMOVE_COUPON_VENDOR)
        return error.logAndReturn(this.logger)
      }
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
                [Domain.SqlDB.Op.in]: [BackendTypes.Roles.ADMIN, BackendTypes.Roles.VENDOR]
              }
            }
          },
          {
            model: DBModels.CouponModel,
            required: false,
            where: {
              id
            }
          }
        ]
      })
      if (!contractModel) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_REMOVE_COUPON_INVALID_CONTRACT)
        return error.logAndReturn(this.logger)
      }
      const couponModels = contractModel?.coupons
      if (!couponModels || couponModels.length !== 1) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_REMOVE_COUPON_COUPON_NOT_FOUND)
        return error.logAndReturn(this.logger)
      }
      await couponModels[0].destroy()
      return new Utils.Return(true)
    } catch (exception: any) {
      this.logger.error(exception)
      return new Utils.Return(false)
    }
  }

  async getCoupons(identity: Types.Classes.CUser, timestamp = 0) {
    try {
      const role = BackendTypes.Roles.valueOf(identity.role)
      if (role !== BackendTypes.Roles.VENDOR) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_GET_COUPON_VENDOR)
        return error.logAndReturn(this.logger)
      }
      const where =
        timestamp && timestamp != 0 && Number(Logics.Finances.toNumber(timestamp)) == timestamp
          ? {
              createdAt: {
                [Domain.SqlDB.Op.lt]: new Date(Number(Logics.Finances.toNumber(timestamp)))
              }
            }
          : null
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
                [Domain.SqlDB.Op.in]: [BackendTypes.Roles.ADMIN, BackendTypes.Roles.VENDOR]
              }
            }
          },
          {
            model: DBModels.CouponModel,
            required: false,
            where: {
              ...{},
              ...where
            },
            order: [['createdAt', 'DESC']],
            limit: this.limit
          }
        ]
      })
      if (!contractModel) {
        const error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_GET_COUPON_INVALID_CONTRACT)
        return error.logAndReturn(this.logger)
      }
      const couponModels = contractModel?.coupons

      const coupons = couponModels?.map(couponModel => {
        return Types.Classes.CCoupon.init(
          couponModel.name ?? '-',
          couponModel.value ?? 0,
          couponModel.minValue ?? 0,
          couponModel.valueType ?? Types.Types.TDiscount.NO,
          couponModel.quantity,
          couponModel.validity,
          couponModel?.createdAt,
          couponModel.id,
          couponModel?.createdAt.getTime()
        )
      })
      return new Utils.Return(
        true,
        coupons?.sort((item1, item2) => (item2?.timestamp ?? 0) - (item1?.timestamp ?? 0))
      )
    } catch (exception: any) {
      this.logger.error(exception)
      return new Utils.Return(false)
    }
  }

  async getCouponsCount(identity: Types.Classes.CUser) {
    const role = BackendTypes.Roles.valueOf(identity.role)
    if (role !== BackendTypes.Roles.VENDOR) {
      return new Utils.Return(false, 0)
    }
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
              [Domain.SqlDB.Op.in]: [BackendTypes.Roles.ADMIN, BackendTypes.Roles.VENDOR]
            }
          }
        },
        {
          model: DBModels.CouponModel,
          required: false
        }
      ]
    })
    if (!contractModel) {
      const error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_GET_COUPONS_COUNT_INVALID_CONTRACT
      )
      return error.logAndReturn(this.logger)
    }
    const couponModels = contractModel?.coupons
    return new Utils.Return(true, couponModels?.length)
  }

  async getSubscription(identity: Types.Classes.CUser) {
    try {
      const dueDate = Logics.DateTime?.parseAsaasDate(Logics.DateTime?.localToday())
      dueDate.setDate(dueDate.getDate() + 30)
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
                [Domain.SqlDB.Op.in]: [BackendTypes.Roles.VENDOR]
              }
            }
          },
          {
            model: DBModels.PlanModel,
            required: true
          },
          {
            model: DBModels.ContractPaymentSignatureModel,
            required: true,
            include: [
              {
                model: DBModels.ContractPaymentModel,
                required: false,
                order: [['dueDate', 'DESC']],
                where: {
                  dueDate: {
                    [Domain.SqlDB.Op.lte]: dueDate
                  }
                }
              }
            ]
          }
        ]
      })
      if (!contractModel) {
        const error = new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_INVALID_CONTRACT
        )
        return error.logAndReturn(this.logger)
      }
      const contractPaymentSignature = contractModel?.contractPaymentSignature
      if (!contractPaymentSignature) {
        const error = new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_INVALID_PAYMENT_SIGNATURE
        )
        return error.logAndReturn(this.logger)
      }
      const planModel = contractModel?.plan
      if (!planModel) {
        const error = new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_INVALID_PLAN
        )
        return error.logAndReturn(this.logger)
      }
      const chargeModels = contractPaymentSignature?.contractPayments
      const charges =
        chargeModels?.map(charge => {
          return Types.Classes.CSubscriptionCharge.init(
            charge?.value ?? 0,
            charge?.creditCardNumber ?? 0,
            charge?.creditCardBrand ?? '-',
            charge?.dueDate ?? new Date(),
            charge?.status ?? Types.Types.TAsaasPaymentStatus.PENDING,
            charge?.invoiceUrl ?? undefined,
            charge?.transactionReceiptUrl ?? undefined,
            charge?.confirmedDate ?? undefined
          )
        }) ?? []
      const subscriptionObject = Types.Classes.CSubscription.init(
        planModel?.name ?? '-',
        contractPaymentSignature?.value ?? 0,
        contractPaymentSignature?.createdAt,
        contractPaymentSignature?.status ?? Types.Types.TAsaasSignatureStatus.CANCELED,
        contractPaymentSignature?.nextDueDate ?? new Date(),
        charges
      )
      return new Utils.Return(true, subscriptionObject)
    } catch (exception: any) {
      this.logger.warn(exception)
      const error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_NEW_PAYMENT_METHOD_EXCEPTION,
        exception
      )
      return error.logAndReturn(this.logger)
    }
  }
}
