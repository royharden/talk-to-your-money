export interface Transaction {
  id: string;
  date: string;
  amount_cents: number;
  merchant_raw: string;
  merchant: string;
  description: string;
  source: string;
  category: string;
  category_conf: number;
  category_source: string;
  recurring_p: number;
  needs_review: boolean;
  jev_response: any;
  created_at: string;
}

export interface Rule {
  id: string;
  merchant: string;
  category: string;
  created_at: string;
}

export interface Budget {
  id: string;
  category: string;
  month: string;
  amount_cents: number;
}

export interface Receipt {
  id: string;
  transaction_id: string | null;
  image_path: string | null;
  parsed: any;
  created_at: string;
}

export interface QuestionLog {
  id: string;
  text: string;
  jev_route: any;
  query_name: string;
  result: any;
  answer: any;
  created_at: string;
}

export type Mode = "live" | "mock" | "offline";

export interface ParsedTransaction {
  date: string;
  amount_cents: number;
  merchant_raw: string;
  merchant: string;
  description: string;
  source: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  parsed?: ParsedTransaction[];
  answer?: string;
  highlight_numbers?: string[];
  suggestion?: string | null;
  chart_data?: any;
  intent?: string;
  fallback?: boolean;
  needs_clarification?: boolean;
  clarification_options?: string[];
}

export interface QueryResult {
  query_name: string;
  result: any;
}
