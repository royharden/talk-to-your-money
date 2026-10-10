export const CATEGORIES = [
  "Groceries",
  "Dining",
  "Transport",
  "Rent/Housing",
  "Utilities",
  "Subscriptions",
  "Shopping",
  "Health",
  "Entertainment",
  "Travel",
  "Income",
  "Transfers",
  "Fees",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_COLORS: Record<string, string> = {
  Groceries: "#10b981",
  Dining: "#f59e0b",
  Transport: "#3b82f6",
  "Rent/Housing": "#8b5cf6",
  Utilities: "#06b6d4",
  Subscriptions: "#ec4899",
  Shopping: "#ef4444",
  Health: "#14b8a6",
  Entertainment: "#f97316",
  Travel: "#a855f7",
  Income: "#22c55e",
  Transfers: "#64748b",
  Fees: "#dc2626",
  Other: "#94a3b8",
};

export const CATEGORY_ICONS: Record<string, string> = {
  Groceries: "ShoppingCart",
  Dining: "UtensilsCrossed",
  Transport: "Car",
  "Rent/Housing": "Home",
  Utilities: "Zap",
  Subscriptions: "Repeat",
  Shopping: "ShoppingBag",
  Health: "HeartPulse",
  Entertainment: "Clapperboard",
  Travel: "Plane",
  Income: "TrendingUp",
  Transfers: "ArrowLeftRight",
  Fees: "Receipt",
  Other: "Circle",
};

export const SOURCES = ["chat", "voice", "receipt", "statement"] as const;
export type Source = (typeof SOURCES)[number];

export const MAX_CUSTOM_CATEGORIES = 5;
