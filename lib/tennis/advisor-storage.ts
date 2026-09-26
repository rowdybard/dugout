// Used in one D1 batch. The caller's nonce distinguishes a new reservation
// from a concurrent replay of the same message ID.
export const reserveMessageSql='INSERT OR IGNORE INTO cache(key,value,updated) SELECT ?,?,? FROM cache WHERE key=? AND CAST(value AS INTEGER)<=?';
export const reserveAllowanceSql='UPDATE cache SET value=CAST(CAST(value AS INTEGER)+? AS TEXT),updated=? WHERE key=? AND EXISTS(SELECT 1 FROM cache WHERE key=? AND value=?)';
