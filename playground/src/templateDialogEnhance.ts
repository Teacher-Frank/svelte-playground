export type EnhanceResult = {
  type?: string;
  data?: {
    message?: string;
    deployWorkloadName?: string;
    deployTaskNode?: string;
    deployTaskUpids?: string[];
  };
};

type EnhanceArgs = {
  result?: EnhanceResult;
  update: () => Promise<void>;
};

type DialogEnhanceOptions = {
  closeDialog: () => void;
  onSubmitStart: () => void;
  onSubmitEnd: (result?: EnhanceResult) => void;
};

export const focusAndSelectInput = (input: HTMLInputElement | null): void => {
  setTimeout(() => {
    input?.focus();
    input?.select();
  }, 0);
};

export const createOptimisticDialogEnhance = (options: DialogEnhanceOptions) => {
  if (typeof window === 'undefined') return;

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  options.onSubmitStart();
  options.closeDialog();

  return async ({ result, update }: EnhanceArgs) => {
    await update();
    window.scrollTo({ left: scrollX, top: scrollY, behavior: 'auto' });
    options.onSubmitEnd(result);
  };
};
