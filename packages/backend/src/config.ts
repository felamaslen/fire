/** Per-currency metadata used to translate between major and minor denominations. */
export const CURRENCIES = {
  /** United Arab Emirates dirham */
  AED: { scale: 2 }, // fils (1/100)
  /** Argentine peso */
  ARS: { scale: 2 }, // centavo (1/100)
  /** Australian dollar */
  AUD: { scale: 2 }, // cent (1/100)
  /** Bangladeshi taka */
  BDT: { scale: 2 }, // poisha (1/100)
  /** Bahraini dinar */
  BHD: { scale: 3 }, // fils (1/1000)
  /** Brazilian real */
  BRL: { scale: 2 }, // centavo (1/100)
  /** Canadian dollar */
  CAD: { scale: 2 }, // cent (1/100)
  /** Swiss franc */
  CHF: { scale: 2 }, // rappen / centime (1/100)
  /** Chilean peso */
  CLP: { scale: 0 }, // no minor unit (centavo withdrawn)
  /** Chinese yuan renminbi */
  CNY: { scale: 2 }, // fen (分, 1/100)
  /** Colombian peso */
  COP: { scale: 2 }, // centavo (1/100)
  /** Czech koruna */
  CZK: { scale: 2 }, // haléř (1/100 — no longer minted, still ISO's minor unit)
  /** Danish krone */
  DKK: { scale: 2 }, // øre (1/100 — no longer minted, still ISO's minor unit)
  /** Egyptian pound */
  EGP: { scale: 2 }, // piastre (1/100)
  /** Euro */
  EUR: { scale: 2 }, // cent (1/100)
  /** Pound sterling */
  GBP: { scale: 2 }, // penny (1/100)
  /** Ghanaian cedi */
  GHS: { scale: 2 }, // pesewa (1/100)
  /** Hong Kong dollar */
  HKD: { scale: 2 }, // cent (1/100)
  /** Hungarian forint */
  HUF: { scale: 2 }, // fillér (1/100 — no longer minted)
  /** Israeli new shekel */
  ILS: { scale: 2 }, // agora (1/100)
  /** Indian rupee */
  INR: { scale: 2 }, // paisa (1/100)
  /** Icelandic króna */
  ISK: { scale: 0 }, // no minor unit (eyrir withdrawn 2003)
  /** Jordanian dinar */
  JOD: { scale: 3 }, // fils (1/1000)
  /** Japanese yen */
  JPY: { scale: 0 }, // no minor unit (sen withdrawn 1953)
  /** Kenyan shilling */
  KES: { scale: 2 }, // cent (1/100)
  /** South Korean won */
  KRW: { scale: 0 }, // no minor unit (jeon withdrawn)
  /** Kuwaiti dinar */
  KWD: { scale: 3 }, // fils (1/1000)
  /** Sri Lankan rupee */
  LKR: { scale: 2 }, // cent (1/100)
  /** Moroccan dirham */
  MAD: { scale: 2 }, // centime (1/100)
  /** Mexican peso */
  MXN: { scale: 2 }, // centavo (1/100)
  /** Malaysian ringgit */
  MYR: { scale: 2 }, // sen (1/100)
  /** Nigerian naira */
  NGN: { scale: 2 }, // kobo (1/100)
  /** Norwegian krone */
  NOK: { scale: 2 }, // øre (1/100 — no longer minted, still ISO's minor unit)
  /** New Zealand dollar */
  NZD: { scale: 2 }, // cent (1/100)
  /** Omani rial */
  OMR: { scale: 3 }, // baisa (1/1000)
  /** Peruvian sol */
  PEN: { scale: 2 }, // céntimo (1/100)
  /** Philippine peso */
  PHP: { scale: 2 }, // sentimo (1/100)
  /** Pakistani rupee */
  PKR: { scale: 2 }, // paisa (1/100)
  /** Polish złoty */
  PLN: { scale: 2 }, // grosz (1/100)
  /** Qatari riyal */
  QAR: { scale: 2 }, // dirham (1/100)
  /** Romanian leu */
  RON: { scale: 2 }, // ban (1/100)
  /** Serbian dinar */
  RSD: { scale: 2 }, // para (1/100)
  /** Russian ruble */
  RUB: { scale: 2 }, // kopeck (1/100)
  /** Saudi riyal */
  SAR: { scale: 2 }, // halala (1/100)
  /** Seychellois rupee */
  SCR: { scale: 2 }, // cent (1/100)
  /** Swedish krona */
  SEK: { scale: 2 }, // öre (1/100)
  /** Singapore dollar */
  SGD: { scale: 2 }, // cent (1/100)
  /** Thai baht */
  THB: { scale: 2 }, // satang (1/100)
  /** Tunisian dinar */
  TND: { scale: 3 }, // millime (1/1000)
  /** Turkish lira */
  TRY: { scale: 2 }, // kuruş (1/100)
  /** New Taiwan dollar */
  TWD: { scale: 2 }, // fen (分, 1/100)
  /** Ukrainian hryvnia */
  UAH: { scale: 2 }, // kopiyka (1/100)
  /** United States dollar */
  USD: { scale: 2 }, // cent (1/100)
  /** Uruguayan peso */
  UYU: { scale: 2 }, // centésimo (1/100)
  /** Venezuelan bolívar soberano */
  VES: { scale: 2 }, // céntimo (1/100)
  /** Vietnamese đồng */
  VND: { scale: 0 }, // no minor unit (hào / xu withdrawn)
  /** South African rand */
  ZAR: { scale: 2 }, // cent (1/100)
} as const satisfies Record<string, { scale: number }>;

/** ISO-4217 code of the home currency: the single currency all aggregate totals (`NetWorthEntry.totalAssets`, etc.) are expressed in, and the default used when no currency is specified on a client input. `satisfies` checks it's one of `CURRENCIES`; the `CurrencyCode` type itself is re-exported from `@/db/schema/currency` (derived from the Drizzle pgEnum). */
export const HOME_CURRENCY = "GBP" satisfies keyof typeof CURRENCIES;
