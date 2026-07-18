import type { HostError } from "./errors.js";
import type { HostEventName } from "./events.js";
import type { HostMethod } from "./methods.js";
import type { HostIdentity } from "./types.js";
import type {
  HostContextMap,
  HostEventPayloadMap,
  HostRequestParams,
  HostResultMap,
} from "./contracts.js";

export type HostRequestEnvelope<M extends HostMethod = HostMethod> = {
  protocolVersion: 1;
  id: string;
  method: M;
  context: HostContextMap[M];
  params: HostRequestParams[M];
};

export type HostSuccessEnvelope<M extends HostMethod = HostMethod> = HostIdentity & {
  protocolVersion: 1;
  id: string;
  method: M;
  ok: true;
  result: HostResultMap[M];
};

export type HostFailureEnvelope<M extends HostMethod = HostMethod> = HostIdentity & {
  protocolVersion: 1;
  id: string;
  method: M;
  ok: false;
  error: HostError;
};

export type HostResponseEnvelope<M extends HostMethod = HostMethod> =
  | HostSuccessEnvelope<M>
  | HostFailureEnvelope<M>;

type HostEventEnvelopeFor<E extends HostEventName> = HostIdentity & {
  protocolVersion: 1;
  event: E;
  sequence: number;
  timestamp: number;
  payload: HostEventPayloadMap[E];
};

/** Distributed union so `switch (event.event)` narrows payload when E defaults to HostEventName. */
export type HostEventEnvelope<E extends HostEventName = HostEventName> =
  E extends HostEventName ? HostEventEnvelopeFor<E> : never;

export function createSuccessResponse<M extends HostMethod>(
  identity: HostIdentity,
  id: string,
  method: M,
  result: HostResultMap[M],
): HostSuccessEnvelope<M> {
  return {
    protocolVersion: 1,
    ...identity,
    id,
    method,
    ok: true,
    result,
  };
}

export function createFailureResponse<M extends HostMethod | string>(
  identity: HostIdentity,
  id: string,
  method: M,
  error: HostError,
): HostFailureEnvelope & { method: M } {
  return {
    protocolVersion: 1,
    ...identity,
    id,
    method,
    ok: false,
    error,
  } as HostFailureEnvelope & { method: M };
}

export function createEvent<E extends HostEventName>(
  identity: HostIdentity,
  event: E,
  sequence: number,
  payload: HostEventPayloadMap[E],
): HostEventEnvelopeFor<E> {
  return {
    protocolVersion: 1,
    ...identity,
    event,
    sequence,
    timestamp: Date.now(),
    payload,
  };
}
