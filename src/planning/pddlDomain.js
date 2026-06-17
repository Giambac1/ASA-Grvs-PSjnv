/**
 * STRIPS domain for Deliveroo navigation and single-parcel delivery,
 * aligned with the course reference domain (lab5 `domain-deliveroo.pddl`).
 * The runtime still uses PDDL mainly as a `go_to` plan, but the same
 * domain can now express a full collect-and-deliver subproblem for
 * experiments and report comparisons.
 *
 * Edge predicates are emitted only where movement is allowed, so one-way
 * arrow tiles are encoded for free: a forbidden entry simply has no edge.
 *
 * TODO(strategy): add crate-pushing actions from
 * `domain-deliveroojs-crates.pddl` for the Sokoban-style practice maps.
 */

export const DOMAIN_NAME = 'deliveroo-asa';

export const DELIVEROO_DOMAIN = `
(define (domain ${DOMAIN_NAME})
  (:requirements :strips)
  (:predicates
    (at ?t)            ; the agent stands on tile ?t
    (parcel ?p)        ; ?p is a parcel object
    (parcel-at ?p ?t)  ; parcel ?p is free on tile ?t
    (carrying ?p)      ; the agent carries parcel ?p
    (delivery ?t)      ; tile ?t accepts deliveries
    (delivered ?p)     ; parcel ?p was delivered
    (up ?from ?to)     ; ?to is one step up from ?from and entry is allowed
    (down ?from ?to)
    (left ?from ?to)
    (right ?from ?to)
  )
  (:action move-up
    :parameters (?from ?to)
    :precondition (and (at ?from) (up ?from ?to))
    :effect (and (not (at ?from)) (at ?to))
  )
  (:action move-down
    :parameters (?from ?to)
    :precondition (and (at ?from) (down ?from ?to))
    :effect (and (not (at ?from)) (at ?to))
  )
  (:action move-left
    :parameters (?from ?to)
    :precondition (and (at ?from) (left ?from ?to))
    :effect (and (not (at ?from)) (at ?to))
  )
  (:action move-right
    :parameters (?from ?to)
    :precondition (and (at ?from) (right ?from ?to))
    :effect (and (not (at ?from)) (at ?to))
  )
  (:action pickup
    :parameters (?p ?t)
    :precondition (and (parcel ?p) (at ?t) (parcel-at ?p ?t))
    :effect (and (not (parcel-at ?p ?t)) (carrying ?p))
  )
  (:action putdown
    :parameters (?p ?t)
    :precondition (and (parcel ?p) (at ?t) (delivery ?t) (carrying ?p))
    :effect (and (not (carrying ?p)) (delivered ?p))
  )
)
`.trim();

/** Map solved plan action names back to game move directions. */
export const ACTION_TO_DIRECTION = {
  'move-up': 'up',
  'move-down': 'down',
  'move-left': 'left',
  'move-right': 'right',
};
