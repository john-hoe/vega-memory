import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

export interface StripeConfig {
  secretKey?: string;
  webhookSecret?: string;
  publishableKey?: string;
  enabled: boolean;
}

export interface StripeCustomer {
  id: string;
  email: string;
  name?: string;
  tenantId: string;
}

export interface StripeSubscription {
  id: string;
  customerId: string;
  planId: string;
  status: "active" | "past_due" | "canceled" | "trialing";
  currentPeriodEnd: string;
}

export interface StripePlan {
  id: string;
  name: string;
  amount: number;
  currency: string;
  interval: "month" | "year";
  features: string[];
  limits: {
    memories: number;
    users: number;
    storage_mb: number;
  };
}

const STUB_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

const STUB_PLANS: StripePlan[] = [
  {
    id: "free",
    name: "Free",
    amount: 0,
    currency: "usd",
    interval: "month",
    features: ["Core memory storage", "Single workspace", "Community support"],
    limits: {
      memories: 1_000,
      users: 1,
      storage_mb: 100
    }
  },
  {
    id: "pro",
    name: "Pro",
    amount: 2_900,
    currency: "usd",
    interval: "month",
    features: ["Higher memory quota", "Team collaboration", "Webhook integrations"],
    limits: {
      memories: 10_000,
      users: 10,
      storage_mb: 2_048
    }
  },
  {
    id: "enterprise",
    name: "Enterprise",
    amount: 9_900,
    currency: "usd",
    interval: "year",
    features: ["Unlimited memories", "SSO and RBAC", "Priority support"],
    limits: {
      memories: -1,
      users: -1,
      storage_mb: -1
    }
  }
];

function createStubId(prefix: "cus" | "sub"): string {
  return `${prefix}_stub_${randomUUID().replaceAll("-", "")}`;
}

function getPeriodEnd(): string {
  return new Date(Date.now() + STUB_PERIOD_MS).toISOString();
}

function getPlanById(planId: string): StripePlan | undefined {
  return STUB_PLANS.find((plan) => plan.id === planId);
}

function secureCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function getWebhookEvent(parsed: {
  type?: unknown;
  event?: unknown;
}): string {
  if (typeof parsed.type === "string") {
    return parsed.type;
  }

  if (typeof parsed.event === "string") {
    return parsed.event;
  }

  return "stripe.stub.event";
}

function getWebhookSubscriptionId(object: {
  id?: unknown;
  subscription?: unknown;
}): string | null {
  if (typeof object.id === "string") {
    return object.id;
  }

  if (typeof object.subscription === "string") {
    return object.subscription;
  }

  return null;
}

export class StripeService {
  private readonly customers = new Map<string, StripeCustomer>();
  private readonly subscriptions = new Map<string, StripeSubscription>();

  constructor(private readonly config: StripeConfig) {}

  async createCustomer(email: string, name: string, tenantId: string): Promise<StripeCustomer> {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedName = name.trim();
    const normalizedTenantId = tenantId.trim();

    for (const existing of this.customers.values()) {
      if (existing.email === normalizedEmail && existing.tenantId === normalizedTenantId) {
        const nextCustomer =
          normalizedName.length === 0
            ? existing
            : {
                ...existing,
                name: normalizedName
              };

        this.customers.set(nextCustomer.id, nextCustomer);
        return nextCustomer;
      }
    }

    const customer: StripeCustomer = {
      id: createStubId("cus"),
      email: normalizedEmail,
      name: normalizedName || undefined,
      tenantId: normalizedTenantId
    };

    this.customers.set(customer.id, customer);
    return customer;
  }

  async getCustomer(customerId: string): Promise<StripeCustomer | null> {
    return this.customers.get(customerId) ?? null;
  }

  async createSubscription(customerId: string, planId: string): Promise<StripeSubscription> {
    if (!this.customers.has(customerId)) {
      throw new Error(`Stripe customer not found: ${customerId}`);
    }

    if (getPlanById(planId) === undefined) {
      throw new Error(`Stripe plan not found: ${planId}`);
    }

    const existing = [...this.subscriptions.values()].find(
      (subscription) =>
        subscription.customerId === customerId &&
        (subscription.status === "active" || subscription.status === "trialing")
    );

    if (existing) {
      const nextSubscription: StripeSubscription = {
        ...existing,
        planId,
        status: "active",
        currentPeriodEnd: getPeriodEnd()
      };

      this.subscriptions.set(nextSubscription.id, nextSubscription);
      return nextSubscription;
    }

    const subscription: StripeSubscription = {
      id: createStubId("sub"),
      customerId,
      planId,
      status: "active",
      currentPeriodEnd: getPeriodEnd()
    };

    this.subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  async cancelSubscription(subscriptionId: string): Promise<StripeSubscription> {
    const existing = this.subscriptions.get(subscriptionId);

    if (existing === undefined) {
      throw new Error(`Stripe subscription not found: ${subscriptionId}`);
    }

    const canceled: StripeSubscription = {
      ...existing,
      status: "canceled"
    };

    this.subscriptions.set(subscriptionId, canceled);
    return canceled;
  }

  async getSubscription(subscriptionId: string): Promise<StripeSubscription | null> {
    return this.subscriptions.get(subscriptionId) ?? null;
  }

  async listPlans(): Promise<StripePlan[]> {
    return STUB_PLANS.map((plan) => ({
      ...plan,
      features: [...plan.features],
      limits: { ...plan.limits }
    }));
  }

  async handleWebhook(payload: string, signature: string): Promise<{ event: string; data: unknown }> {
    this.verifyWebhookSignature(payload, signature);

    const parsed = JSON.parse(payload) as {
      type?: unknown;
      event?: unknown;
      data?: unknown;
    };

    const result = {
      event: getWebhookEvent(parsed),
      data: parsed.data ?? parsed
    };

    this.applyWebhook(result.event, result.data);

    return result;
  }

  async createCheckoutSession(
    customerId: string,
    planId: string,
    successUrl: string,
    cancelUrl: string
  ): Promise<{ url: string }> {
    if (!this.customers.has(customerId)) {
      throw new Error(`Stripe customer not found: ${customerId}`);
    }

    if (getPlanById(planId) === undefined) {
      throw new Error(`Stripe plan not found: ${planId}`);
    }

    return {
      url: `${successUrl}?checkout_session_id=${encodeURIComponent(
        `cs_stub_${customerId}_${planId}`
      )}&cancel_url=${encodeURIComponent(cancelUrl)}`
    };
  }

  isConfigured(): boolean {
    return this.config.enabled && typeof this.config.secretKey === "string" && this.config.secretKey.length > 0;
  }

  async getSubscriptionByTenantId(tenantId: string): Promise<StripeSubscription | null> {
    for (const subscription of this.subscriptions.values()) {
      const customer = this.customers.get(subscription.customerId);

      if (customer?.tenantId === tenantId) {
        return subscription;
      }
    }

    return null;
  }

  private verifyWebhookSignature(payload: string, signature: string): void {
    if (!this.config.webhookSecret || signature.trim().length === 0) {
      return;
    }

    if (signature.startsWith("t=")) {
      const parts = Object.fromEntries(
        signature.split(",").map((part) => {
          const [key, value = ""] = part.split("=", 2);
          return [key.trim(), value.trim()];
        })
      );
      const timestamp = parts.t;
      const expected = parts.v1;

      if (!timestamp || !expected) {
        throw new Error("Invalid Stripe signature header");
      }

      const digest = createHmac("sha256", this.config.webhookSecret)
        .update(`${timestamp}.${payload}`)
        .digest("hex");

      if (!secureCompare(digest, expected)) {
        throw new Error("Invalid Stripe webhook signature");
      }

      return;
    }

    const digest = createHmac("sha256", this.config.webhookSecret).update(payload).digest("hex");
    if (!secureCompare(digest, signature)) {
      throw new Error("Invalid Stripe webhook signature");
    }
  }

  private applyWebhook(event: string, data: unknown): void {
    if (typeof data !== "object" || data === null || !("object" in data)) {
      return;
    }

    const object = (data as { object?: unknown }).object;
    if (typeof object !== "object" || object === null) {
      return;
    }

    const subscriptionId = getWebhookSubscriptionId(
      object as { id?: unknown; subscription?: unknown }
    );

    if (subscriptionId === null) {
      return;
    }

    const existing = this.subscriptions.get(subscriptionId);
    if (!existing) {
      return;
    }

    let status = existing.status;

    if (event === "customer.subscription.deleted") {
      status = "canceled";
    } else if (event === "invoice.payment_failed") {
      status = "past_due";
    } else if (event === "customer.subscription.updated") {
      status =
        ((object as { status?: unknown }).status as StripeSubscription["status"] | undefined) ??
        existing.status;
    }

    this.subscriptions.set(subscriptionId, {
      ...existing,
      status
    });
  }
}
