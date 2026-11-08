export const IS_WINDOWS = process.platform === 'win32';

export const EMPTY_OUTPUT_COMMAND = IS_WINDOWS ? 'exit /b 0' : 'true';
export const NON_ZERO_EXIT_COMMAND = IS_WINDOWS ? 'exit /b 1' : 'false';
export const LONG_EMPTY_OUTPUT_COMMAND = IS_WINDOWS
  ? `rem ${'#'.repeat(500)}`
  : `true ${'#'.repeat(500)}`;
export const PRINT_WORKING_DIRECTORY_COMMAND = IS_WINDOWS ? 'cd' : 'pwd';

export function printEnvCommand(name: string): string {
  return IS_WINDOWS
    ? `if defined ${name} (echo %${name}%) else (echo.)`
    : `echo "$${name}"`;
}

export function printEnvPairCommand(first: string, second: string): string {
  return IS_WINDOWS
    ? `echo %${first}%/%${second}%`
    : `echo "$${first}/$${second}"`;
}
