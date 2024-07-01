import {
  pointToRendererPoint,
  getHostForElement,
  calcAutoPan,
  getEventPosition,
  getHandlePosition,
  rendererPointToPoint,
} from '../utils';
import {
  ConnectionMode,
  Position,
  oppositePosition,
  ConnectionInProgress,
  type Handle,
  type Connection,
} from '../types';

import { getClosestHandle, isConnectionValid, getHandleLookup, getHandleType } from './utils';
import { IsValidParams, OnPointerDownParams, Result, XYHandleInstance } from './types';

const alwaysValid = () => true;

function onPointerDown(
  event: MouseEvent | TouchEvent,
  {
    connectionMode,
    connectionRadius,
    handleId,
    nodeId,
    edgeUpdaterType,
    isTarget,
    domNode,
    nodeLookup,
    lib,
    autoPanOnConnect,
    flowId,
    panBy,
    cancelConnection,
    onConnectStart,
    onConnect,
    onConnectEnd,
    isValidConnection = alwaysValid,
    onReconnectEnd,
    updateConnection,
    getTransform,
    getFromHandle,
  }: OnPointerDownParams
) {
  // when xyflow is used inside a shadow root we can't use document
  const doc = getHostForElement(event.target as HTMLElement);
  let autoPanId = 0;
  let closestHandle: Handle | null;

  const { x, y } = getEventPosition(event);
  const clickedHandle = doc?.elementFromPoint(x, y);
  const handleType = getHandleType(edgeUpdaterType, clickedHandle);
  const containerBounds = domNode?.getBoundingClientRect();

  if (!containerBounds || !handleType) {
    return;
  }

  let position = getEventPosition(event, containerBounds);
  let autoPanStarted = false;
  let connection: Connection | null = null;
  let isValid: boolean | null = false;
  let handleDomNode: Element | null = null;

  const [handleLookup, fromHandleInternal] = getHandleLookup({
    nodeLookup,
    nodeId,
    handleId,
    handleType,
  });

  // when the user is moving the mouse close to the edge of the canvas while connecting we move the canvas
  function autoPan(): void {
    if (!autoPanOnConnect || !containerBounds) {
      return;
    }
    const [x, y] = calcAutoPan(position, containerBounds);

    panBy({ x, y });
    autoPanId = requestAnimationFrame(autoPan);
  }

  // Stays the same for all consecutive pointermove events
  const fromHandle: Handle = {
    ...fromHandleInternal,
    nodeId,
    type: handleType,
    position: fromHandleInternal.position,
  };

  const fromNodeInternal = nodeLookup.get(nodeId)!;

  const from = getHandlePosition(fromNodeInternal, fromHandle, Position.Left, true);

  const newConnection: ConnectionInProgress = {
    inProgress: true,
    isValid: null,

    from,
    fromHandle,
    fromPosition: fromHandle.position,
    fromNode: fromNodeInternal.internals.userNode,

    to: position,
    toHandle: null,
    toPosition: oppositePosition[fromHandle.position],
    toNode: null,
  };

  updateConnection(newConnection);
  let previousConnection: ConnectionInProgress = newConnection;

  onConnectStart?.(event, { nodeId, handleId, handleType });

  function onPointerMove(event: MouseEvent | TouchEvent) {
    if (!getFromHandle() || !fromHandle) {
      onPointerUp(event);
      return;
    }

    const transform = getTransform();
    position = getEventPosition(event, containerBounds);
    closestHandle = getClosestHandle(
      pointToRendererPoint(position, transform, false, [1, 1]),
      connectionRadius,
      handleLookup
    );

    if (!autoPanStarted) {
      autoPan();
      autoPanStarted = true;
    }

    const result = isValidHandle(event, {
      handle: closestHandle,
      connectionMode,
      fromNodeId: nodeId,
      fromHandleId: handleId,
      fromType: isTarget ? 'target' : 'source',
      isValidConnection,
      doc,
      lib,
      flowId,
      handleLookup,
    });

    handleDomNode = result.handleDomNode;
    connection = result.connection;
    isValid = isConnectionValid(!!closestHandle, result.isValid);

    const newConnection: ConnectionInProgress = {
      // from stays the same
      ...previousConnection,
      isValid,
      to:
        closestHandle && isValid
          ? rendererPointToPoint({ x: closestHandle.x, y: closestHandle.y }, transform)
          : position,
      toHandle: result.toHandle,
      toPosition: isValid && result.toHandle ? result.toHandle.position : oppositePosition[fromHandle.position],
      toNode: result.toHandle ? nodeLookup.get(result.toHandle.nodeId)!.internals.userNode : null,
    };

    // we don't want to trigger an update when the connection
    // is snapped to the same handle as before
    if (
      isValid &&
      closestHandle &&
      previousConnection.toHandle &&
      newConnection.toHandle &&
      previousConnection.toHandle.type === newConnection.toHandle.type &&
      previousConnection.toHandle.nodeId === newConnection.toHandle.nodeId &&
      previousConnection.toHandle.id === newConnection.toHandle.id
    ) {
      return;
    }

    updateConnection(newConnection);
    previousConnection = newConnection;
  }

  function onPointerUp(event: MouseEvent | TouchEvent) {
    if ((closestHandle || handleDomNode) && connection && isValid) {
      onConnect?.(connection);
    }

    // it's important to get a fresh reference from the store here
    // in order to get the latest state of onConnectEnd
    onConnectEnd?.(event);

    if (edgeUpdaterType) {
      onReconnectEnd?.(event);
    }

    cancelConnection();
    cancelAnimationFrame(autoPanId);
    autoPanStarted = false;
    isValid = false;
    connection = null;
    handleDomNode = null;

    doc.removeEventListener('mousemove', onPointerMove as EventListener);
    doc.removeEventListener('mouseup', onPointerUp as EventListener);

    doc.removeEventListener('touchmove', onPointerMove as EventListener);
    doc.removeEventListener('touchend', onPointerUp as EventListener);
  }

  doc.addEventListener('mousemove', onPointerMove as EventListener);
  doc.addEventListener('mouseup', onPointerUp as EventListener);

  doc.addEventListener('touchmove', onPointerMove as EventListener);
  doc.addEventListener('touchend', onPointerUp as EventListener);
}

// checks if  and returns connection in fom of an object { source: 123, target: 312 }
function isValidHandle(
  event: MouseEvent | TouchEvent,
  {
    handle,
    connectionMode,
    fromNodeId,
    fromHandleId,
    fromType,
    doc,
    lib,
    flowId,
    isValidConnection = alwaysValid,
    handleLookup,
  }: IsValidParams
) {
  const isTarget = fromType === 'target';
  const handleDomNode = handle
    ? doc.querySelector(`.${lib}-flow__handle[data-id="${flowId}-${handle?.nodeId}-${handle?.id}-${handle?.type}"]`)
    : null;

  const { x, y } = getEventPosition(event);
  const handleBelow = doc.elementFromPoint(x, y);
  // we always want to prioritize the handle below the mouse cursor over the closest distance handle,
  // because it could be that the center of another handle is closer to the mouse pointer than the handle below the cursor
  const handleToCheck = handleBelow?.classList.contains(`${lib}-flow__handle`) ? handleBelow : handleDomNode;

  const result: Result = {
    handleDomNode: handleToCheck,
    isValid: false,
    connection: null,
    toHandle: null,
  };

  if (handleToCheck) {
    const handleType = getHandleType(undefined, handleToCheck);
    const handleNodeId = handleToCheck.getAttribute('data-nodeid');
    const handleId = handleToCheck.getAttribute('data-handleid');
    const connectable = handleToCheck.classList.contains('connectable');
    const connectableEnd = handleToCheck.classList.contains('connectableend');

    if (!handleNodeId) {
      return result;
    }

    const connection: Connection = {
      source: isTarget ? handleNodeId : fromNodeId,
      sourceHandle: isTarget ? handleId : fromHandleId,
      target: isTarget ? fromNodeId : handleNodeId,
      targetHandle: isTarget ? fromHandleId : handleId,
    };

    result.connection = connection;

    const isConnectable = connectable && connectableEnd;
    // in strict mode we don't allow target to target or source to source connections
    const isValid =
      isConnectable &&
      (connectionMode === ConnectionMode.Strict
        ? (isTarget && handleType === 'source') || (!isTarget && handleType === 'target')
        : handleNodeId !== fromNodeId || handleId !== fromHandleId);

    result.isValid = isValid && isValidConnection(connection);

    if (handleLookup) {
      const toHandle = handleLookup.find(
        (h) => h.id === handleId && h.nodeId === handleNodeId && h.type === handleType
      );

      if (toHandle) {
        result.toHandle = {
          ...toHandle,
        };
      }
    }
  }

  return result;
}

export const XYHandle: XYHandleInstance = {
  onPointerDown,
  isValid: isValidHandle,
};
