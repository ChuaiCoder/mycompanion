// Tavern's boolean vocabulary, shared by argument validation and conditions.
export const isTrueBoolean = value => ['true', 'on', 'yes', '1'].includes(String(value).toLowerCase());
export const isFalseBoolean = value => ['false', 'off', 'no', '0'].includes(String(value).toLowerCase());
