/**
 * Structured team message protocol (Agent A <-> Agent B).
 *
 * Every message is a JSON envelope:
 *   { protocol, type, payload, from, ts }
 *
 * Message types and payloads:
 *  - hello          {name, isReply?}            handshake / teammate discovery
 *  - position       {x, y, carrying, intention} ~1s heartbeat of own state
 *  - intention      {key, type}                 current intention announcement
 *  - claim          {parcelId}                  target deconfliction (first claim wins)
 *  - mission-update {mission}                   structured mission from Agent B's interpreter
 *  - request-help   {reason, x?, y?}            ask teammate for assistance
 *  - handover       {parcelId, x, y, role}      one-pickup-another-deliver coordination
 *  - ack            {about}                     acknowledgement of the named type
 *
 * Free-text / non-envelope messages (e.g. mission-agent shouts) are NOT
 * protocol messages: they are ignored by TeamProtocol and handled by the
 * LLM layer instead.
 */

export const PROTOCOL = 'asa-team-v1';

export const MessageTypes = {
  HELLO: 'hello',
  POSITION: 'position',
  INTENTION: 'intention',
  CLAIM: 'claim',
  MISSION_UPDATE: 'mission-update',
  REQUEST_HELP: 'request-help',
  HANDOVER: 'handover',
  ACK: 'ack',
};

/** Build a protocol envelope. */
export function makeMessage(type, payload = {}, from = null) {
  return { protocol: PROTOCOL, type, payload, from, ts: Date.now() };
}

/** True when an incoming msg is one of ours. */
export function isProtocolMessage(msg) {
  return !!msg && typeof msg === 'object' && msg.protocol === PROTOCOL && typeof msg.type === 'string';
}
