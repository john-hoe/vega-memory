export interface Plan {
  id: string;
  name: string;
  memoriesLimit: number;
  usersLimit: number;
  storageLimitMB: number;
  priceMonthly: number | null;
  features: string[];
}

export interface FeatureLimits {
  memories: number;
  users: number;
  storageMB: number;
  apiRateLimit: number;
  wikiPages: number;
  customBranding: boolean;
}

interface PlanDefinition {
  plan: Plan;
  limits: FeatureLimits;
  rank: number;
}

const PLAN_DEFINITIONS: readonly PlanDefinition[] = [
  {
    plan: {
      id: "free",
      name: "Free",
      memoriesLimit: 100,
      usersLimit: 1,
      storageLimitMB: 10,
      priceMonthly: 0,
      features: ["Core memory storage", "Single-user workspace", "Basic wiki pages"]
    },
    limits: {
      memories: 100,
      users: 1,
      storageMB: 10,
      apiRateLimit: 10_000,
      wikiPages: 10,
      customBranding: false
    },
    rank: 0
  },
  {
    plan: {
      id: "pro",
      name: "Pro",
      memoriesLimit: 10_000,
      usersLimit: 10,
      storageLimitMB: 1_024,
      priceMonthly: 29,
      features: ["Team collaboration", "Higher API throughput", "Expanded wiki capacity"]
    },
    limits: {
      memories: 10_000,
      users: 10,
      storageMB: 1_024,
      apiRateLimit: 100_000,
      wikiPages: 1_000,
      customBranding: false
    },
    rank: 1
  },
  {
    plan: {
      id: "enterprise",
      name: "Enterprise",
      memoriesLimit: -1,
      usersLimit: -1,
      storageLimitMB: -1,
      priceMonthly: null,
      features: ["Unlimited usage", "Custom contract", "SSO and custom branding"]
    },
    limits: {
      memories: -1,
      users: -1,
      storageMB: -1,
      apiRateLimit: -1,
      wikiPages: -1,
      customBranding: true
    },
    rank: 2
  }
] as const;

const clonePlan = (plan: Plan): Plan => ({
  ...plan,
  features: [...plan.features]
});

const cloneLimits = (limits: FeatureLimits): FeatureLimits => ({
  ...limits
});

export class PlanManager {
  private readonly plansById = new Map<string, PlanDefinition>(
    PLAN_DEFINITIONS.map((definition) => [definition.plan.id, definition])
  );

  getPlan(planId: string): Plan | undefined {
    const definition = this.plansById.get(planId);
    return definition ? clonePlan(definition.plan) : undefined;
  }

  listPlans(): Plan[] {
    return PLAN_DEFINITIONS.map((definition) => clonePlan(definition.plan));
  }

  canUpgrade(from: string, to: string): boolean {
    const fromDefinition = this.plansById.get(from);
    const toDefinition = this.plansById.get(to);

    return Boolean(fromDefinition && toDefinition && toDefinition.rank > fromDefinition.rank);
  }

  canDowngrade(from: string, to: string): boolean {
    const fromDefinition = this.plansById.get(from);
    const toDefinition = this.plansById.get(to);

    return Boolean(fromDefinition && toDefinition && toDefinition.rank < fromDefinition.rank);
  }

  getFeatureLimits(planId: string): FeatureLimits {
    const definition = this.plansById.get(planId);

    if (definition === undefined) {
      throw new Error(`Unknown plan: ${planId}`);
    }

    return cloneLimits(definition.limits);
  }
}
