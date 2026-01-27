jest.mock('../api/chat/api_test/agent-execution', () => ({
  executeApiAgentTestFlow: jest.fn(),
}));

jest.mock('@/services/utils/chat.service', () => ({
  ChatService: {
    saveChatMessages: jest.fn(async () => {}),
  },
}));

jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: {
    emitChatProcessingStep: jest.fn(),
    emitApiAgentStep: jest.fn(),
    emitChatMessage: jest.fn(),
    emitChatTestUpdate: jest.fn(),
  },
}));

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('chat api_test → api-agent routing', () => {
  it('asks for clarification when apiUrl missing', async () => {
    const res = makeRes();
    const { executeApiAgentTestFlow } = require('../api/chat/api_test/agent-execution') as {
      executeApiAgentTestFlow: jest.Mock;
    };
    const { handleApiTest } = require('../api/chat/api_test/handler') as {
      handleApiTest: Function;
    };

    await handleApiTest({} as any, res as any, {
      message: 'test GET endpoint',
      parsedIntent: { apiMethod: 'GET' },
      userId: 'user_1',
      workspace_id: 'workspace_1',
      chatSessionId: 'chat_1',
    });

    expect(executeApiAgentTestFlow).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        needsMoreInfo: true,
        sessionId: 'chat_1',
        questions: expect.arrayContaining([
          expect.objectContaining({ id: 'apiUrl' }),
        ]),
      })
    );
  });

  it('defaults to light when no level specified', async () => {
    const res = makeRes();
    const { executeApiAgentTestFlow } = require('../api/chat/api_test/agent-execution') as {
      executeApiAgentTestFlow: jest.Mock;
    };
    const { handleApiTest } = require('../api/chat/api_test/handler') as {
      handleApiTest: Function;
    };

    await handleApiTest({} as any, res as any, {
      message: 'Check GET https://api.example.com/users',
      parsedIntent: { apiMethod: 'GET', apiUrl: 'https://api.example.com/users' },
      userId: 'user_1',
      workspace_id: 'workspace_1',
      chatSessionId: 'chat_1',
    });

    expect(executeApiAgentTestFlow).toHaveBeenCalledWith(
      res,
      expect.objectContaining({
        level: 'light',
        method: 'GET',
        url: 'https://api.example.com/users',
        chatSessionId: 'chat_1',
      })
    );
  });

  it('parses level from message text (hard)', async () => {
    const res = makeRes();
    const { executeApiAgentTestFlow } = require('../api/chat/api_test/agent-execution') as {
      executeApiAgentTestFlow: jest.Mock;
    };
    const { handleApiTest } = require('../api/chat/api_test/handler') as {
      handleApiTest: Function;
    };

    await handleApiTest({} as any, res as any, {
      message: 'Run hard api test for GET https://api.example.com/users',
      parsedIntent: { apiMethod: 'GET', apiUrl: 'https://api.example.com/users' },
      userId: 'user_1',
      workspace_id: 'workspace_1',
      chatSessionId: 'chat_1',
    });

    expect(executeApiAgentTestFlow).toHaveBeenCalledWith(
      res,
      expect.objectContaining({
        level: 'hard',
      })
    );
  });

  it('UI-provided parsedIntent.agentLevel overrides text', async () => {
    const res = makeRes();
    const { executeApiAgentTestFlow } = require('../api/chat/api_test/agent-execution') as {
      executeApiAgentTestFlow: jest.Mock;
    };
    const { handleApiTest } = require('../api/chat/api_test/handler') as {
      handleApiTest: Function;
    };

    await handleApiTest({} as any, res as any, {
      message: 'Run hard api test for GET https://api.example.com/users',
      parsedIntent: {
        apiMethod: 'GET',
        apiUrl: 'https://api.example.com/users',
        agentLevel: 'medium',
      },
      userId: 'user_1',
      workspace_id: 'workspace_1',
      chatSessionId: 'chat_1',
    });

    expect(executeApiAgentTestFlow).toHaveBeenCalledWith(
      res,
      expect.objectContaining({
        level: 'medium',
      })
    );
  });
});

