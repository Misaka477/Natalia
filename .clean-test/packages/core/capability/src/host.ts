import { resolve } from "node:path";
import { CapabilityLoadError } from "./errors";
import {
  CapabilityRegistry,
  type CapabilityRegistryHost,
  type CapabilityRegistryView,
} from "./registry";
import type {
  CapabilityExecutionLease,
  CapabilityGrant,
  CapabilityOwnerHandle,
  CapabilityRegistration,
  ServiceUpdate,
} from "./types";

/** Adds execution leases to contribution storage without owning business cleanup. */
export class CapabilityHost implements CapabilityRegistryHost {
  readonly workspaceRoot?: string;
  private readonly registry = new CapabilityRegistry();
  readonly view: CapabilityRegistryView;
  private readonly leases = new Map<string, number>();
  private readonly handles = new Set<CapabilityOwnerHandle>();
  private disposed = false;

  constructor(options: { workspaceRoot?: string } = {}) {
    this.workspaceRoot = options.workspaceRoot
      ? resolve(options.workspaceRoot)
      : undefined;
    this.view = {
      list: () => this.list(),
      has: (id) => this.has(id),
      scopeOf: (id) => this.scopeOf(id),
      withGrant: (grant) => this.withGrant(grant),
      overrides: () => this.overrides(),
      contributions: <T>(kind: CapabilityGrant) => this.contributions<T>(kind),
      contribution: <T>(kind: CapabilityGrant, name: string) =>
        this.contribution<T>(kind, name),
      ownerOf: (kind, name) => this.ownerOf(kind, name),
      service: <T>(name: string) => this.service<T>(name),
      services: () => this.services(),
      onServiceUpdate: (listener) => this.onServiceUpdate(listener),
    };
  }

  registerOwner(registration: CapabilityRegistration): CapabilityOwnerHandle {
    this.assertActive();
    const inner = this.registry.registerOwner(registration);
    let released = false;
    const handle: CapabilityOwnerHandle = Object.freeze({
      id: inner.id,
      contribute: inner.contribute,
      release: () => {
        if (released) return;
        released = true;
        inner.release();
        this.handles.delete(handle);
      },
    });
    this.handles.add(handle);
    return handle;
  }

  acquireExecutionLease(
    capabilityIDs: string | readonly string[],
  ): CapabilityExecutionLease {
    this.assertActive();
    const requested = [
      ...new Set(
        typeof capabilityIDs === "string" ? [capabilityIDs] : capabilityIDs,
      ),
    ];
    if (!requested.length)
      throw new CapabilityLoadError("", "capability lease requires an id");
    for (const id of requested)
      if (!this.registry.has(id))
        throw new CapabilityLoadError(
          id,
          `capability "${id}" is not visible for execution`,
        );
    for (const id of requested)
      this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    let released = false;
    return {
      capabilityIDs: requested,
      release: () => {
        if (released) return;
        released = true;
        for (const id of requested) {
          const remaining = (this.leases.get(id) ?? 1) - 1;
          if (remaining) this.leases.set(id, remaining);
          else this.leases.delete(id);
        }
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of [...this.handles].reverse()) handle.release();
  }

  list() {
    return this.registry.list();
  }

  has(id: string) {
    return this.registry.has(id);
  }

  scopeOf(id: string) {
    return this.registry.scopeOf(id);
  }

  withGrant(grant: CapabilityGrant) {
    return this.registry.withGrant(grant);
  }

  overrides() {
    return this.registry.overrides();
  }

  contributions<T>(kind: CapabilityGrant) {
    return this.registry.contributions<T>(kind);
  }

  contribution<T>(kind: CapabilityGrant, name: string) {
    return this.registry.contribution<T>(kind, name);
  }

  ownerOf(kind: CapabilityGrant, name: string) {
    return this.registry.ownerOf(kind, name);
  }

  service<T>(name: string) {
    return this.registry.service<T>(name);
  }

  services() {
    return this.registry.services();
  }

  onServiceUpdate(listener: (update: ServiceUpdate) => void) {
    return this.registry.onServiceUpdate(listener);
  }

  private assertActive() {
    if (this.disposed)
      throw new CapabilityLoadError("", "capability host is disposed");
  }
}
