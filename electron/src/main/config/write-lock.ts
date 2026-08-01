import {
  _clearSerializedWriteChains,
  withSerializedWrite,
} from '../utils/write-lock';

/** Process-wide key shared by every config read-modify-write cycle. */
const CONFIG_SAVE_LOCK_KEY = '__orchid_config_save__';

/**
 * Run `fn` exclusively after any prior config save completes.
 * Errors from previous operations do not block subsequent ones.
 */
export function withConfigSaveLock<T>(fn: () => Promise<T>): Promise<T> {
  return withSerializedWrite(CONFIG_SAVE_LOCK_KEY, fn);
}

/**
 * Reset the config-save chain. For test isolation only.
 * @internal
 */
export function _resetConfigSaveChainForTests(): void {
  _clearSerializedWriteChains(CONFIG_SAVE_LOCK_KEY);
}
