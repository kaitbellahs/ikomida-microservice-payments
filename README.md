# ikomida-microservice-payments

Charges, coupons and payment-provider webhooks.

> Part of the **iKomida** platform. See **[ikomida-k8s-config](https://github.com/kaitbellahs/ikomida-k8s-config)** for the architecture overview of all 31 repositories.

---

## Role

Integrates two Brazilian payment providers, **PagSeguro** and **Asaas**, each with its own webhook endpoint. Webhook routes are intentionally unauthenticated — the provider calls them, not a logged-in user — and are validated by provider-side signature instead.

Also issues the public key clients use to encrypt card data before it is transmitted, and owns discount coupons.

## Endpoints

As declared in the [gateway route table](https://github.com/kaitbellahs/ikomida-microservice-gateway/blob/dev/src/routes.ts) (15 routes reach this service):

| Method | Path | Roles |
|---|---|---|
| `GET` | `/pubKey` | CLIENT |
| `GET` | `/payments` | CLIENT |
| `GET` | `/payeridtypes` | VENDOR, CLIENT |
| `GET` | `/cardinfo/:cardNumber` | VENDOR, CLIENT |
| `POST` | `/payment` | CLIENT |
| `POST` | `/webhooks/pagseguro/:contractID` | *public* |
| `POST` | `/webhooks/asaas` | *public* |
| `PUT` | `/payment/:id` | CLIENT |
| `DELETE` | `/payment/:id` | CLIENT |
| `POST` | `/processPayment` | CLIENT |
| `POST` | `/coupon` | CLIENT, VENDOR, STAFF |
| `GET` | `/coupons/:timestamp` | VENDOR, STAFF |
| `GET` | `/couponsCount` | VENDOR, STAFF |
| `DELETE` | `/coupon/:id` | VENDOR |
| `GET` | `/vendor/subscription` | VENDOR, ADMIN |

## Stack

TypeScript (ESM) · Express · Sequelize · rollup · Docker · Kubernetes

Depends on [`@ikomida/shared-types`](https://github.com/kaitbellahs/ikomida-shared-types), [`@ikomida/shared-backend`](https://github.com/kaitbellahs/ikomida-shared-backend) and [`@ikomida/shared-logics`](https://github.com/kaitbellahs/ikomida-shared-logics).

## Build

```bash
yarn install
yarn build      # rollup bundle
yarn service    # run locally
```

## Status

Built in 2022. The platform is no longer deployed; this repository is published as a record of the work. **The commit history predates generative AI coding assistants.**

## License

Licensed under the [Apache License 2.0](LICENSE) — free for commercial use, provided the copyright notice and [NOTICE](NOTICE) are retained.

Copyright 2022 Khalid Ait Bellahs.
