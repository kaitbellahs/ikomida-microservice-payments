import { GateWays, Domain, Utils, BackendTypes, Logics, Types, Helpers, DBModels } from '@ikomida/shared-backend'

export default class WebHooks {
  logger
  cashUUID = '00000000-0000-0000-0000-000000000000'
  asaasGateway?: GateWays.Asaas
  limit = 10

  constructor(logger: Utils.Logger) {
    this.logger = logger
    this.asaasGateway = new GateWays.Asaas(this.logger)
  }

  async pagseguro(contractID: string, input: any, authenticityToken?: string) {
    try {
      const payload: Types.Classes.Pagseguro.CPagSeguroChargeResponse =
        Types.Classes.Pagseguro.CPagSeguroChargeResponse.fromObject(input)
      this.logger.log('--pagSegroWebHook:', contractID, payload.toJSON(), authenticityToken)

      const contractModel = await DBModels.ContractModel.findOne({
        where: {
          id: contractID
        },
        include: [
          {
            model: DBModels.PNModel,
            where: {
              role: BackendTypes.Roles.VENDOR
            },
            required: false
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
        const error = new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PAGSEGURO_WEBHOOK_INVALID_CONTRACT
        )
        error.log(this.logger)
        return false
      }
      const paymentObject = payload
      // if (authenticityToken) {
      //     const payloadHash = crypto.createHash('sha256').update(`${gatewayData?.accessToken}-${JSON.stringify(object)}`).digest('hex')
      //     if (authenticityToken == payloadHash) {
      //         paymentObject = object
      //     }
      // } else if (object?.notificationCode) {
      //     return true
      // }

      let userPaymentModel
      let sendPN = false
      const paymentStatus = paymentObject.status
      if (paymentObject) {
        const userPaymentModels = await contractModel.$get('userPayments', {
          where: {
            gateway: GateWays.PagSeguro.name,
            gatewayPaymentID: paymentObject.id
          },
          include: [
            {
              model: DBModels.OrderModel,
              required: false
            },
            {
              model: DBModels.UserModel,
              required: false,
              include: [
                {
                  model: DBModels.PNModel,
                  required: false
                }
              ]
            }
          ]
        })
        if (!userPaymentModels || userPaymentModels.length !== 1) {
          const error = new Utils.iKomidaError(
            Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PAGSEGURO_WEBHOOK_INVALID_USER
          )
          error.log(this.logger)
          return false
        }
        userPaymentModel = userPaymentModels[0]
        if (userPaymentModel.status !== paymentStatus) {
          sendPN = true
          userPaymentModel.status = paymentStatus
          await userPaymentModel.save()
        }
      }
      const order = userPaymentModel?.order
      if (!order) {
        return false
      }
      if (
        order?.status &&
        [Types.Types.TOrderStatus.WAITING_PAYMENT, Types.Types.TOrderStatus.OPEN].includes(order?.status) &&
        (!paymentStatus ||
          ![
            Types.Types.TPagSeguroPaymentStatus.AUTHORIZED,
            Types.Types.TPagSeguroPaymentStatus.INANALYSE,
            Types.Types.TPagSeguroPaymentStatus.PAID
          ].includes(paymentStatus))
      ) {
        sendPN = true
        order.status = Types.Types.TOrderStatus.CANCELED
        await this.cancelPayment(paymentObject, contractModel?.vendorSettings?.vendorPaymentGateway)
      }
      if (
        order?.status &&
        [Types.Types.TOrderStatus.OPEN].includes(order?.status) &&
        paymentStatus &&
        [Types.Types.TPagSeguroPaymentStatus.AUTHORIZED].includes(paymentStatus)
      ) {
        sendPN = true
        order.status = Types.Types.TOrderStatus.WAITING_PAYMENT
      }
      if (
        order?.status &&
        [Types.Types.TOrderStatus.CANCELED].includes(order?.status) &&
        paymentStatus &&
        [Types.Types.TPagSeguroPaymentStatus.PAID].includes(paymentStatus)
      ) {
        sendPN = true
        await this.cancelPayment(paymentObject, contractModel?.vendorSettings?.vendorPaymentGateway)
      }
      if (
        order?.status &&
        [Types.Types.TOrderStatus.WAITING_PAYMENT].includes(order?.status) &&
        paymentStatus &&
        [Types.Types.TPagSeguroPaymentStatus.PAID].includes(paymentStatus)
      ) {
        sendPN = true
        order.status = Types.Types.TOrderStatus.OPEN
      }
      await order.save()
      if (!sendPN) {
        return true
      }
      try {
        const pNModels = contractModel?.pNs
        if ((pNModels?.length ?? 0) === 1) {
          const notification = new Utils.Notification(
            Utils.Notification.ORDER_STATUS,
            paymentStatus ? paymentStatus?.id : ''
          )
          const message = new Types.Classes.CNotificationPayload()
          message.notification = notification
          message.data = new Types.Classes.CNotificationData()
          message.data.method = notification.method
          message.data.uri = notification.uri
          message.data.logon = notification.logon
          message.data.payload = order?.id
          const payload = new Types.Classes.CAMQPPayload<Types.Classes.CAMQPPayloadObject>()
          payload.method = 'send'
          const payloadObject = new Types.Classes.CAMQPPayloadObject()
          payloadObject.message = message
          payloadObject.contractId = contractModel?.id
          payload.object = payloadObject
          const amqp = new Domain.RabbitMQ(this.logger)
          await amqp?.publish<Types.Classes.CAMQPPayloadObject>(Domain.RabbitMQ.PUSH_NOTIFICATION_QUEUE, payload)
          await amqp?.close()
        } else {
          this.logger.warn(
            `[PAGSEGURO_WEBHOOK] - Dispositivo ou usuário não cadastrado para receber notificações push.`
          )
        }
        const userModel = userPaymentModel?.user
        const pNModel = userModel?.pN
        if (pNModel) {
          let notification = new Utils.Notification(
            Utils.Notification.VENDOR_ORDER_UPDATED,
            order?.customID,
            order.status?.name
          )
          const message = new Types.Classes.CNotificationPayload()
          message.notification = notification
          message.data = new Types.Classes.CNotificationData()
          message.data.method = notification.method
          message.data.uri = notification.uri
          message.data.logon = notification.logon
          message.data.payload = order?.id
          const payload = new Types.Classes.CAMQPPayload<Types.Classes.CAMQPPayloadObject>()
          payload.method = 'send'
          const payloadObject = new Types.Classes.CAMQPPayloadObject()
          payloadObject.message = message
          payloadObject.contractId = contractModel?.id
          payload.object = payloadObject
          const amqp = new Domain.RabbitMQ(this.logger)
          await amqp?.publish(Domain.RabbitMQ.PUSH_NOTIFICATION_QUEUE, payload)
          notification = new Utils.Notification(
            Utils.Notification.USER_ORDER_UPDATED,
            order?.customID,
            order.status?.name
          )
          message.notification = notification
          payloadObject.userId = userModel?.id
          await amqp?.publish(Domain.RabbitMQ.PUSH_NOTIFICATION_QUEUE, payload)
          await amqp?.close()
        }
      } catch (exception: any) {
        this.logger.error(exception)
        const error = new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_ORDERS_SERVICE_PAGSEGURO_WEBHOOK_PUSH_NOTIFICATION_EXCEPTION_2,
          exception
        )
        error.log(this.logger)
      }
    } catch (exception: any) {
      this.logger.error(exception)
      const error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PAGSEGUROWEBHOOK_EXCEPTION,
        exception
      )
      error.log(this.logger)
      return false
    }
    return true
  }

  async asaas(object: { payment: any }, authenticityToken: string | undefined) {
    try {
      this.logger.log('[ASAAS_WEBHOOK] - Notificatio received: ', object)
      const asaasAuthenticityToken = process.env.ASAAS_AUTHENTICITY_TOKEN
      if (authenticityToken !== asaasAuthenticityToken) {
        this.logger.log(`[ASAAS_WEBHOOK] - invalid authenticity Token: ${authenticityToken}`)
        return false
      }
      const paymentObject = object?.payment
      const contractDetails = JSON.parse(paymentObject.externalReference)
      if (!contractDetails?.ikomidaID) {
        this.logger.info('[ASAAS_WEBHOOK] - this is an old model, not suported anymore')
        return true
      }
      let contractModel: DBModels.ContractModel | null = null
      let tryCount = 0
      let tryN = 0
      const startTime = new Date().getTime()
      do {
        tryCount++
        try {
          contractModel = await DBModels.ContractModel.findOne({
            where: {
              ikomidaID: contractDetails?.ikomidaID
            },
            include: [
              {
                model: DBModels.ContractPaymentSignatureModel,
                required: false,
                where: {
                  subscriptionID: paymentObject.subscription
                },
                include: [
                  {
                    model: DBModels.ContractPaymentModel,
                    where: {
                      paymentID: paymentObject.id
                    },
                    required: false
                  }
                ]
              },
              {
                model: DBModels.PNModel,
                required: false,
                where: {
                  role: BackendTypes.Roles.VENDOR
                }
              }
            ]
          })
          // eslint-disable-next-line no-empty
        } catch (_) {}
        if (!contractModel) {
          tryN += tryCount
          await Utils.System.sleep(tryN * 250)
        }
      } while (!contractModel && tryCount <= 4 && new Date().getTime() - startTime + (tryN + tryCount * 280) < 10000)
      if (!contractModel) {
        this.logger.error(
          `❌ Não foi localizado nenhum contrato após ${tryCount} tentativas em ${
            (new Date().getTime() - startTime) / 1000
          }s.`
        )
        return true
      }
      this.logger.error(
        `✅ O contrato foi localizado após ${tryCount} tentativas em ${(new Date().getTime() - startTime) / 1000}s.`
      )
      let contractPaymentSignature = contractModel?.contractPaymentSignature
      const subscriptionResponse = await this.asaasGateway?.getSubscription(paymentObject.subscription)
      if (!subscriptionResponse?.success) {
        const error = new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_ASAAS_WEBHOOK_CANT_GET_SUBSCRIPTION
        )
        error.log(this.logger)
        return false
      }
      const subscription = subscriptionResponse.data
      this.logger.log('[ASAAS_WEBHOOK] - subscription:', subscription)
      if (!contractPaymentSignature) {
        this.logger.log('[ASAAS_WEBHOOK] - create Contract Payment Signature not found, recuvering...')
        contractPaymentSignature = await contractModel.$create('contractPaymentSignature', {
          gateway: this.asaasGateway?.name,
          subscriptionID: subscription?.id,
          status: subscription?.status,
          cycle: subscription?.cycle,
          value: Math.ceil((subscription?.value ?? 0) * 100)
        })
        this.logger.log('[ASAAS_WEBHOOK] - create Contract Payment Signature not found, done')
      }
      let lastDueDate = contractPaymentSignature?.lastDueDate
      let nextDueDate = contractPaymentSignature?.nextDueDate

      const dueDate = Logics.DateTime?.parseAsaasDate(paymentObject.dueDate)
      const todayDate = Logics.DateTime?.parseAsaasDate(Logics.DateTime?.localToday())
      const acceptedPaymentStatus = [
        Types.Types.TAsaasPaymentStatus.PENDING,
        Types.Types.TAsaasPaymentStatus.CONFIRMED
      ].includes(paymentObject.status)
      const pendingStatus = [Types.Types.TAsaasPaymentStatus.PENDING].includes(paymentObject.status)

      if (acceptedPaymentStatus && dueDate <= todayDate && (!lastDueDate || dueDate > lastDueDate)) {
        lastDueDate = dueDate
      }
      if (pendingStatus && dueDate > todayDate && (!nextDueDate || dueDate < nextDueDate)) {
        nextDueDate = dueDate
      }
      contractPaymentSignature.status = subscription?.deleted
        ? Types.Types.TAsaasSignatureStatus.CANCELED
        : subscription?.status ?? undefined
      contractPaymentSignature.lastDueDate = lastDueDate
      contractPaymentSignature.nextDueDate = nextDueDate
      contractPaymentSignature.cycle = subscription?.cycle
      contractPaymentSignature.value = Math.ceil((subscription?.value ?? 0) * 100)

      await contractPaymentSignature.save()
      const contractPaymentModels = contractModel?.contractPaymentSignature?.contractPayments
      const paymentStatus = paymentObject.status
      let contractPaymentModel = contractPaymentModels?.[0]
      if ((contractPaymentModels?.length ?? 0) === 1 && contractPaymentModel) {
        contractPaymentModel.status = paymentObject.deleted ? Types.Types.TAsaasPaymentStatus.CANCELED : paymentStatus
        contractPaymentModel.dueDate = Logics.DateTime?.parseAsaasDate(paymentObject.dueDate)
        contractPaymentModel.confirmedDate = Logics.DateTime?.parseAsaasDate(paymentObject.confirmedDate)
        contractPaymentModel.clientPaymentDate = Logics.DateTime?.parseAsaasDate(paymentObject.clientPaymentDate)
        contractPaymentModel.value = Math.ceil(paymentObject.value * 100)
        contractPaymentModel.netValue = Math.ceil(paymentObject.netValue * 100)
        contractPaymentModel.creditCardNumber = paymentObject.creditCard?.creditCardNumber
        contractPaymentModel.creditCardBrand = paymentObject.creditCard?.creditCardBrand
        contractPaymentModel.creditCardToken = paymentObject.creditCard?.creditCardToken
        contractPaymentModel.invoiceUrl = paymentObject.invoiceUrl
        contractPaymentModel.invoiceNumber = paymentObject.invoiceNumber
        contractPaymentModel.transactionReceiptUrl = paymentObject.transactionReceiptUrl
        await contractPaymentModel.save()
      } else {
        const date = Logics.DateTime?.parseAsaasDate(paymentObject.dueDate)
        contractPaymentModel = await contractModel.$create('contractPayment', {
          gateway: 'Asaas',
          subscriptionID: paymentObject.subscription,
          paymentID: paymentObject.id,
          status: paymentObject.status,
          month: date?.getMonth() + 1,
          dueDate: Logics.DateTime?.parseAsaasDate(paymentObject.dueDate),
          confirmedDate: Logics.DateTime?.parseAsaasDate(paymentObject.confirmedDate),
          clientPaymentDate: Logics.DateTime?.parseAsaasDate(paymentObject.clientPaymentDate),
          value: Math.ceil(paymentObject.value * 100),
          netValue: Math.ceil(paymentObject.netValue * 100),
          plan: contractDetails?.plan,
          billingType: paymentObject.billingType,
          creditCardNumber: paymentObject.creditCard?.creditCardNumber,
          creditCardBrand: paymentObject.creditCard?.creditCardBrand,
          creditCardToken: paymentObject.creditCard?.creditCardToken,
          invoiceUrl: paymentObject.invoiceUrl,
          invoiceNumber: paymentObject.invoiceNumber,
          transactionReceiptUrl: paymentObject.transactionReceiptUrl
        })
        await contractPaymentSignature.$add('contractPayment', contractPaymentModel)
      }
      try {
        const pNModels = contractModel?.pNs
        if ((pNModels?.length ?? 0) === 1) {
          const notification = new Utils.Notification(Utils.Notification.NEW_CHARGE)
          const message = new Types.Classes.CNotificationPayload()
          message.notification = notification
          message.data = new Types.Classes.CNotificationData()
          message.data.method = notification.method
          message.data.uri = notification.uri
          message.data.logon = notification.logon
          message.data.payload = contractPaymentModel?.id
          const payload = new Types.Classes.CAMQPPayload<Types.Classes.CAMQPPayloadObject>()
          payload.method = 'send'
          const payloadObject = new Types.Classes.CAMQPPayloadObject()
          payloadObject.message = message
          payloadObject.contractId = contractModel?.id
          payload.object = payloadObject
          const amqp = new Domain.RabbitMQ(this.logger)
          await amqp?.publish(Domain.RabbitMQ.PUSH_NOTIFICATION_QUEUE, payload)
          await amqp?.close()
        } else {
          this.logger.warn(`[ASAAS_WEBHOOK] - Dispositivo ou usuário não cadastrado para receber notificações push.`)
        }
      } catch (exception: any) {
        this.logger.error(exception)
        const error = new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_ASAASWEBHOOK_PUSH_NOTIFICATION_EXCEPTION,
          exception
        )
        error.log(this.logger)
      }
    } catch (exception: any) {
      this.logger.error(exception)
      const error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_ASAASWEBHOOK_EXCEPTION,
        exception
      )
      error.log(this.logger)
      return false
    }
    return true
  }

  async cancelPayment(
    paymentObject: Types.Classes.Pagseguro.CPagSeguroChargeResponse,
    vendorPaymentGateway: DBModels.VendorPaymentGatewayModel | undefined
  ) {
    const paymentStatus = paymentObject.status
    if (paymentStatus && [Types.Types.TOrderStatus.CANCELED].includes(paymentStatus)) {
      return true
    }
    const pagseguroHelper = new Helpers.PagseguroHelper(this.logger)
    const paymentGateway = await pagseguroHelper.configure(vendorPaymentGateway)
    if (!paymentGateway) {
      const error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_PROCESS_PAYMENT_INVALID_VENDOR_PAYMENT_SETTINGS
      )
      return error.logAndReturn(this.logger)
    }
    const cancelPaymentObject: Types.Classes.Pagseguro.CPagSeguroCreateCharge =
      Types.Classes.Pagseguro.CPagSeguroCreateCharge.fromObject({
        id: paymentObject.id,
        amount: paymentObject.amount?.value
      })
    const cancelCharge = await paymentGateway?.cancelCharge(cancelPaymentObject)
    if (!cancelCharge) {
      const error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_PAYMENTS_SERVICE_CANCEL_PAYMENT_RESPONSE_ERROR,
        'Unknown error!'
      )
      error.log(this.logger)
      return false
    }
    return true
  }
}
