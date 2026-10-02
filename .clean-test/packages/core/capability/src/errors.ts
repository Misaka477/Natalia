export class CapabilityLoadError extends Error {
  readonly capabilityID: string;

  constructor(capabilityID: string, message: string) {
    super(message);
    this.name = "CapabilityLoadError";
    this.capabilityID = capabilityID;
  }
}
