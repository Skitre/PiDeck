export {};

declare module "@earendil-works/pi-coding-agent" {
  interface PackageManager {
    setOperationSignal(signal: AbortSignal | undefined): void;
    update(source?: string, options?: { local?: boolean }): Promise<void>;
  }

  interface DefaultPackageManager {
    setOperationSignal(signal: AbortSignal | undefined): void;
    update(source?: string, options?: { local?: boolean }): Promise<void>;
  }
}
