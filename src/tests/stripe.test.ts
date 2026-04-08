import assert from "node:assert/strict";
import test from "node:test";

import { StripeService } from "../billing/stripe.js";

test("StripeService stub returns the documented plan catalog", async () => {
  const service = new StripeService({
    enabled: false
  });

  const plans = await service.listPlans();

  assert.equal(plans.length, 3);
  assert.deepEqual(
    plans.map((plan) => plan.id),
    ["free", "pro", "enterprise"]
  );
});

test("StripeService stub creates customer and subscription IDs with stub prefixes", async () => {
  const service = new StripeService({
    enabled: true,
    secretKey: "sk_test_stub"
  });

  const customer = await service.createCustomer("billing@example.com", "Billing User", "tenant-1");
  const subscription = await service.createSubscription(customer.id, "pro");

  assert.match(customer.id, /^cus_stub_/);
  assert.equal(customer.email, "billing@example.com");
  assert.equal(customer.tenantId, "tenant-1");
  assert.match(subscription.id, /^sub_stub_/);
  assert.equal(subscription.customerId, customer.id);
  assert.equal(subscription.planId, "pro");
  assert.equal(subscription.status, "active");
  assert.equal(Number.isNaN(Date.parse(subscription.currentPeriodEnd)), false);
});

test("StripeService stub returns null for missing resources and cancels subscriptions", async () => {
  const service = new StripeService({
    enabled: true,
    secretKey: "sk_test_stub"
  });
  const customer = await service.createCustomer("ops@example.com", "Ops", "tenant-ops");
  const subscription = await service.createSubscription(customer.id, "enterprise");

  assert.equal(await service.getCustomer("cus_missing"), null);
  assert.equal(await service.getSubscription("sub_missing"), null);

  const canceled = await service.cancelSubscription(subscription.id);

  assert.equal(canceled.status, "canceled");
  assert.equal((await service.getSubscriptionByTenantId("tenant-ops"))?.id, subscription.id);
});

test("StripeService stub parses webhook payloads and reports configuration state", async () => {
  const configuredService = new StripeService({
    enabled: true,
    secretKey: "sk_test_stub",
    webhookSecret: "whsec_stub",
    publishableKey: "pk_test_stub"
  });
  const unconfiguredService = new StripeService({
    enabled: false
  });

  const webhook = await configuredService.handleWebhook(
    JSON.stringify({
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_stub_123"
        }
      }
    }),
    "sig_stub"
  );

  assert.equal(webhook.event, "invoice.payment_succeeded");
  assert.deepEqual(webhook.data, {
    object: {
      id: "in_stub_123"
    }
  });
  assert.equal(configuredService.isConfigured(), true);
  assert.equal(unconfiguredService.isConfigured(), false);
});
