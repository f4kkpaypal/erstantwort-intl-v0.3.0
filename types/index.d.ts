export type LeadGrade = 'HOT' | 'WARM' | 'COLD';
export type LeadStatus = 'pending_approval' | 'review' | 'sent' | 'stopped' | 'archived';
export type ViewingStatus = 'unconfirmed' | 'confirmed' | 'cancelled';

export interface PropertyItem {
  id: string;
  title: string;
  kind?: 'sale' | 'rent';
  price?: number;
  currency?: string;
  price_period?: string;
  rooms?: number;
  area_sqm?: number;
  tz?: string;
  tz_label_en?: string;
  tz_label_ru?: string;
  brochure_url?: string;
  plan_url?: string;
  photos?: string[];
}

export interface BookingSlot {
  id: string;
  start_utc: string;
  end_utc: string;
  label?: string;
  held_by?: string;
  held_until?: string;
}

export interface LeadAttachment {
  kind: 'brochure' | 'plan' | 'link';
  name: string;
  url: string;
  file_id?: string | null;
}

export interface LeadDraft {
  version: number;
  text: string;
  option_id?: string | null;
  slot_ids?: string[];
  attachments?: LeadAttachment[];
}

export interface InboundMessage {
  id?: string;
  lead_id?: string;
  channel: 'telegram' | 'wa_sim';
  sender_id: string;
  sender_name?: string;
  text: string;
  property_id?: string;
  direction?: 'in' | 'out';
  created_at?: string;
}

export interface IntlConfig {
  PRODUCT_MODE: 'de' | 'intl';
  CHANNEL_MODE: 'sim' | 'live';
  REAL_DATA_ALLOWED?: boolean | string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ALLOWED_USER_IDS?: string | string[];
  MULTI_USER?: boolean | string;
  HASH_SALT: string;
  UI_PUBLIC_BASE?: string;
  INTL_DATABASE_URL?: string;
  DATA_DIR?: string;
  DEEPSEEK_API_KEY?: string;
  GEMINI_API_KEY?: string;
}
