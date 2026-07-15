export const dedupeAsync = async <Key, Value>(
  pendingByKey: Map<Key, Promise<Value>>,
  key: Key,
  compute: () => Promise<Value>,
) => {
  const pending = pendingByKey.get(key);
  if (pending) {
    return await pending;
  }

  const started = compute();
  pendingByKey.set(key, started);
  try {
    return await started;
  } finally {
    if (pendingByKey.get(key) === started) {
      pendingByKey.delete(key);
    }
  }
};
