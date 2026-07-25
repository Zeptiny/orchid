interface Disposable {
  dispose(): void;
}

/** Run a synchronous operation and always dispose its owned resource. */
export function withDisposable<T extends Disposable, R>(
  resource: T,
  operation: (resource: T) => R,
): R {
  try {
    return operation(resource);
  } finally {
    resource.dispose();
  }
}

/** Run an asynchronous operation and dispose its resource after it settles. */
export async function withDisposableAsync<T extends Disposable, R>(
  resource: T,
  operation: (resource: T) => Promise<R>,
): Promise<R> {
  try {
    return await operation(resource);
  } finally {
    resource.dispose();
  }
}
