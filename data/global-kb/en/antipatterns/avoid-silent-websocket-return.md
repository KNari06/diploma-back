# WebSocket handlers must always respond

A WebSocket handler that silently returns without emitting a response leaves the frontend stuck on a loading spinner forever. There is no timeout, no retry — the user waits until they reload the page.

## Wrong

```ts
// Frontend hangs forever if session is missing
socket.on('preview:data:request', async () => {
  if (!session) return;
  // ... the rest never runs, frontend gets no signal
});
```

## Right

```ts
socket.on('preview:data:request', async () => {
  if (!session) {
    socket.emit('preview:data:response', {
      error: 'No active session',
      code: 'NO_SESSION',
    });
    return;
  }

  try {
    const data = await loadSessionData(session);
    socket.emit('preview:data:response', { data });
  } catch (err) {
    socket.emit('preview:data:response', {
      error: err instanceof Error ? err.message : 'Unknown error',
      code: 'LOAD_FAILED',
    });
  }
});
```

## The rule

Every code path through a WebSocket handler — including early returns, guard clauses, caught exceptions, and unreachable-looking branches — must end in an `emit` of the paired response event. If the frontend is listening, the backend must speak.

## Pattern: response helper

For handlers that always respond to the same event name, wrap the emit:

```ts
const respond = (payload: { data?: unknown; error?: string; code?: string }) =>
  socket.emit('preview:data:response', payload);

socket.on('preview:data:request', async () => {
  if (!session) return respond({ error: 'No active session', code: 'NO_SESSION' });
  try {
    respond({ data: await loadSessionData(session) });
  } catch (err) {
    respond({ error: err instanceof Error ? err.message : 'Unknown error', code: 'LOAD_FAILED' });
  }
});
```

This makes it impossible to forget the response.

## Why this rule exists

This was a real bug: a preview data request handler returned early when the session was missing. The frontend's "Loading…" spinner stayed forever. Users assumed the app was broken. The fix was adding an error emit — five lines that should have been there from day one.
