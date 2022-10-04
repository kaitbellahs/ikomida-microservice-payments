import express from 'express'
import bodyParser from 'body-parser'
import Payments from './controllers/Payments.js'
import WebHooks from './controllers/WebHooks.js'
import User from './controllers/User.js'
import Vendor from './controllers/Vendor.js'
import { BackendTypes, Types, Utils } from '@ikomida/shared-backend'

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
let { name } = require('../package.json')
name = name
  .replace(/^(@\S+\/)?(svelte-)?(\S+)/, '$3')
  .replace(/^\w/, (m: string) => m.toUpperCase())
  .replace(/-\w/g, (m: string[]) => m[1].toUpperCase())
const logger = Utils.Logger.getInstance(name)

const app = express()
app.disable('x-powered-by')
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json({ limit: '10mb' }))
Utils.System.setExpressResponse(app)
const port = process?.env?.PORT || 80
let payments = new Payments(logger)
let webHooks = new WebHooks(logger)
let user = new User(logger)
let vendor = new Vendor(logger)

app.post('/cancelPayment', async (req, res) => {
  const payload = await payments.cancelPayment(Types.Classes.CUser.fromObject(req.headers?.identity), req.body)
  res.sendResponse(payload)
})

app.get('/payments', async (req, res, next) => {
  const payload = await user.getPaymentMethods(Types.Classes.CUser.fromObject(req.headers?.identity))
  res.status(200).sendResponse(payload)
})

app.post('/payment', async (req, res) => {
  const payload = await user.newCreditCard(Types.Classes.CUser.fromObject(req.headers?.identity), req.body)
  res.status(payload?.success ? 201 : 200).sendResponse(payload)
})

app.put('/payment/:id', async (req, res) => {
  const payload = await user.updatePaymentMethod(Types.Classes.CUser.fromObject(req.headers?.identity), req?.params?.id)
  res.status(payload?.success ? 201 : 200).sendResponse(payload)
})

app.delete('/payment/:id', async (req, res) => {
  const payload = await user.removePaymentMethod(Types.Classes.CUser.fromObject(req.headers?.identity), req?.params?.id)
  res.status(payload?.success ? 201 : 200).sendResponse(payload)
})

app.post('/processPayment', async (req, res) => {
  const payload = await payments.processPayment(Types.Classes.CUser.fromObject(req.headers?.identity), req.body)
  res.status(payload?.success ? 201 : 200).sendResponse(payload)
})

app.post('/coupon', async (req, res) => {
  let payload
  switch (BackendTypes.Roles.valueOf(Types.Classes.CUser.fromObject(req.headers?.identity)?.role)) {
    case BackendTypes.Roles.VENDOR:
    case BackendTypes.Roles.STAFF:
      payload = await vendor.newCoupon(Types.Classes.CUser.fromObject(req.headers?.identity), req.body)
      break
    case BackendTypes.Roles.CLIENT:
      payload = await user.addCoupon(Types.Classes.CUser.fromObject(req.headers?.identity), req.body?.coupon)
      break
  }
  res.status(payload?.success ? 201 : 403).sendResponse(payload)
})

app.delete('/coupon/:id', async (req, res) => {
  let payload
  if (
    BackendTypes.Roles.valueOf(Types.Classes.CUser.fromObject(req.headers?.identity).role) === BackendTypes.Roles.VENDOR
  ) {
    payload = await vendor.removeCoupon(Types.Classes.CUser.fromObject(req.headers?.identity), req.params.id)
  }
  res.status(payload?.success ? 201 : 200).sendResponse(payload)
})

app.get('/coupons/:timestamp', async (req, res) => {
  const payload = await vendor.getCoupons(
    Types.Classes.CUser.fromObject(req.headers?.identity),
    Number(req.params?.timestamp) ?? 0
  )
  res.sendResponse(payload)
})

app.get('/couponsCount', async (req, res) => {
  const payload = await vendor.getCouponsCount(Types.Classes.CUser.fromObject(req.headers?.identity))
  res.sendResponse(payload)
})

app.get('/vendor/subscription', async (req, res) => {
  const payload = await vendor.getSubscription(Types.Classes.CUser.fromObject(req.headers?.identity))
  res.sendResponse(payload)
})

app.post('/webhooks/pagseguro/:contractID', async (req, res) => {
  const response = await webHooks.pagseguro(
    req.params.contractID,
    req.body,
    String(req?.headers?.['x-authenticity-token'])
  )
  response ? res.sendStatus(200) : res.sendStatus(500)
})

app.post('/webhooks/asaas', async (req, res) => {
  const response = await webHooks.asaas(req.body, String(req?.headers?.['asaas-access-token']))
  response ? res.sendStatus(200) : res.sendStatus(500)
})

app.all('*', async (req, res) => {
  logger.error(`Payments endpoint: "${req?.url}" not found:`)
  res.status(404).sendResponse({ error: 'NOT FOUND' })
})

payments = new Payments(logger)
webHooks = new WebHooks(logger)
user = new User(logger)
vendor = new Vendor(logger)

app.listen(port, () => {
  logger.info(`${name} listening at http://localhost:${port}`)
})
