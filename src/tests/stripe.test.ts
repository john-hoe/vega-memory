import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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

test("StripeService reuses customers per tenant/email and creates subscriptions with stub IDs", async () => {
  const service = new StripeService({
    enabled: true,
    secretKey: "sk_test_stub"
  });

  const customer = await service.createCustomer("billing@example.com", "Billing User", "tenant-1");
  const sameCustomer = await service.createCustomer("billing@example.com", "Updated Billing User", "tenant-1");
  const subscription = await service.createSubscription(customer.id, "pro");

  assert.match(customer.id, /^cus_stub_/);
  assert.equal(sameCustomer.id, customer.id);
  assert.equal(sameCustomer.name, "Updated Billing User");
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
  await assert.rejects(
    service.createSubscription(customer.id, "unknown-plan"),
    /Stripe plan not found/
  );
});

test("StripeService verifies webhook signatures and updates subscriptions", async () => {
  const configuredService = new StripeService({
    enabled: true,
    secretKey: "sk_test_stub",
    webhookSecret: "whsec_stub",
    publishableKey: "pk_test_stub"
  });
  const unconfiguredService = new StripeService({
    enabled: false
  });
  const customer = await configuredService.createCustomer("ops@example.com", "Ops", "tenant-ops");
  const subscription = await configuredService.createSubscription(customer.id, "pro");
  const payload = JSON.stringify({
    type: "customer.subscription.updated",
    data: {
      object: {
        id: subscription.id,
        status: "past_due"
      }
    }
  });
  const signature = createHmac("sha256", "whsec_stub").update(payload).digest("hex");

  const webhook = await configuredService.handleWebhook(
    payload,
    signature
  );

  assert.equal(webhook.event, "customer.subscription.updated");
  assert.deepEqual(webhook.data, {
    object: {
      id: subscription.id,
      status: "past_due"
    }
  });
  assert.equal((await configuredService.getSubscription(subscription.id))?.status, "past_due");
  assert.equal(configuredService.isConfigured(), true);
  assert.equal(unconfiguredService.isConfigured(), false);

  await assert.rejects(
    configuredService.handleWebhook(payload, "bad-signature"),
    /Invalid Stripe webhook signature/
  );
});
