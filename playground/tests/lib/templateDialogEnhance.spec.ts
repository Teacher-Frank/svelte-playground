import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOptimisticDialogEnhance,
  focusAndSelectInput,
  type EnhanceResult,
} from '../../src/templateDialogEnhance.js';

describe('templateDialogEnhance helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('focusAndSelectInput focuses and selects on next tick', () => {
    const input = {
      focus: vi.fn(),
      select: vi.fn(),
    } as unknown as HTMLInputElement;

    focusAndSelectInput(input);

    expect(input.focus).not.toHaveBeenCalled();
    expect(input.select).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(input.focus).toHaveBeenCalledTimes(1);
    expect(input.select).toHaveBeenCalledTimes(1);
  });

  it('createOptimisticDialogEnhance returns undefined when window is unavailable', () => {
    const closeDialog = vi.fn();
    const onSubmitStart = vi.fn();
    const onSubmitEnd = vi.fn();

    const originalWindow = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;

    const handler = createOptimisticDialogEnhance({
      closeDialog,
      onSubmitStart,
      onSubmitEnd,
    });

    expect(handler).toBeUndefined();
    expect(closeDialog).not.toHaveBeenCalled();
    expect(onSubmitStart).not.toHaveBeenCalled();
    expect(onSubmitEnd).not.toHaveBeenCalled();

    if (originalWindow !== undefined) {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it('runs optimistic start/close immediately and completes via returned handler', async () => {
    const closeDialog = vi.fn();
    const onSubmitStart = vi.fn();
    const onSubmitEnd = vi.fn();
    const scrollTo = vi.fn();

    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      scrollX: 12,
      scrollY: 34,
      scrollTo,
    };

    const handler = createOptimisticDialogEnhance({
      closeDialog,
      onSubmitStart,
      onSubmitEnd,
    });

    expect(handler).toBeTypeOf('function');
    expect(onSubmitStart).toHaveBeenCalledTimes(1);
    expect(closeDialog).toHaveBeenCalledTimes(1);

    const update = vi.fn(async () => Promise.resolve());
    const result: EnhanceResult = { type: 'failure', data: { message: 'failed' } };

    await handler!({ result, update });

    expect(update).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ left: 12, top: 34, behavior: 'auto' });
    expect(onSubmitEnd).toHaveBeenCalledWith(result);

    if (originalWindow !== undefined) {
      (globalThis as { window?: unknown }).window = originalWindow;
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
