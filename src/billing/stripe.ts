// Stripe billing stub — replace stub methods with stripe SDK calls. Install: npm install stripe
import { randomUUID } from "node:crypto";

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

const createStubId = (prefix: "cus" | "sub"): string => `${prefix}_stub_${randomUUID().replaceAll("-", "")}`;

const getPeriodEnd = (): string => new Date(Date.now() + STUB_PERIOD_MS).toISOString();

export class StripeService {
  private readonly customers = new Map<string, StripeCustomer>();
  private readonly subscriptions = new Map<string, StripeSubscription>();

  constructor(private readonly config: StripeConfig) {}

  async createCustomer(email: string, name: string, tenantId: string): Promise<StripeCustomer> {
    const customer: StripeCustomer = {
      id: createStubId("cus"),
      email: email.trim().toLowerCase(),
      name: name.trim() || undefined,
      tenantId: tenantId.trim()
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

  async handleWebhook(payload: string, _signature: string): Promise<{ event: string; data: unknown }> {
    const parsed = JSON.parse(payload) as {
      type?: unknown;
      event?: unknown;
      data?: unknown;
    };

    const event =
      typeof parsed.type === "string"
        ? parsed.type
        : typeof parsed.event === "string"
          ? parsed.event
          : "stripe.stub.event";

    return {
      event,
      data: parsed.data ?? parsed
    };
  }

  async createCheckoutSession(
    _customerId: string,
    _planId: string,
    _successUrl: string,
    _cancelUrl: string
  ): Promise<{ url: string }> {
    return {
      url: "/billing/success"
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
}
