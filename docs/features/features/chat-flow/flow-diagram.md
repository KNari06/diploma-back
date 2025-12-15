flowchart TD
    Start([POST /api/v1/chat]) --> AuthMiddleware[requireAuth Middleware]
    AuthMiddleware --> ValidateSchema[Validate Request Schema]
    ValidateSchema -->|Invalid| Return400[Return 400 Bad Request]
    ValidateSchema -->|Valid| HandleChat[handleChat Controller]

    HandleChat --> SetupTimeout[Setup Request Timeout]
    SetupTimeout --> SetupConnectionCheck[Setup Connection Check]
    SetupConnectionCheck --> TryBlock[Try Block]

    TryBlock --> CheckConnection1[checkConnection]
    CheckConnection1 -->|Closed| ThrowConnectionError[throw Error: Connection closed]
    CheckConnection1 -->|OK| Step0[STEP 0: validateInput]

    Step0 --> CheckInput{Input Valid?}
    CheckInput -->|No| Return400Step0[Return 400 - Response sent]
    CheckInput -->|Yes| ExtractData[Extract: userId, message, context, sessionId]
    ExtractData --> CheckTimeout1[checkRequestTimeout]

    CheckTimeout1 --> Step1[STEP 1: checkWorkspace]
    Step1 --> CheckTimeout2[checkRequestTimeout]
    CheckTimeout2 --> Step2[STEP 2: manageChatSession]
    Step2 --> CheckTimeout3[checkRequestTimeout]

    CheckTimeout3 --> Step2_2[STEP 2.2: hasActiveRequest?]
    Step2_2 -->|Yes| Return409[Return 409 Conflict - Request in progress]
    Step2_2 -->|No| Step2_3[STEP 2.3: registerActiveRequest]

    Step2_3 --> GetAbortSignal[Get AbortSignal]
    GetAbortSignal --> CheckAborted1[checkRequestAborted]
    CheckAborted1 -->|Aborted| ThrowAborted[throw Error: Request cancelled]
    CheckAborted1 -->|OK| Step3[STEP 3: checkPendingApproval]

    Step3 --> ApprovalHandled{Approval Handled?}
    ApprovalHandled -->|Yes| Unregister1[unregisterActiveRequest]
    Unregister1 --> ReturnApproval[Return - Response sent]
    ApprovalHandled -->|No| CheckAborted2[checkRequestAborted]

    CheckAborted2 --> Step4[STEP 4: parseIntent]
    Step4 --> CheckTimeout4[checkRequestTimeout]
    CheckTimeout4 --> CheckAborted3[checkRequestAborted]

    CheckAborted3 --> Step5[STEP 5: routeToHandler]
    Step5 --> EmitRouting[emitProcessingStep: Processing request]
    EmitRouting --> CheckAborted4[checkRequestAborted]

    CheckAborted4 --> IntentCheck{Intent Type?}

    IntentCheck -->|needs_clarification| HandleClarification[handleClarificationRequest]
    IntentCheck -->|platform_test| HandlePlatform[handlePlatformTest]
    IntentCheck -->|api_test| HandleApi[handleApiTest]
    IntentCheck -->|general_chat| HandleGeneral[handleGeneralChat]

    HandleClarification --> SaveHistory1[Save to Chat History]
    HandlePlatform --> SaveHistory2[Save to Chat History]
    HandleApi --> SaveHistory3[Save to Chat History]
    HandleGeneral --> SaveHistory4[Save to Chat History]

    SaveHistory1 --> Unregister2[unregisterActiveRequest]
    SaveHistory2 --> Unregister2
    SaveHistory3 --> Unregister2
    SaveHistory4 --> Unregister2

    Unregister2 --> ReturnSuccess[Return 200 Success]

    TryBlock -->|Exception| CatchBlock[Catch Block]
    CatchBlock --> CheckErrorType{Error Type?}

    CheckErrorType -->|Timeout| ReturnTimeout[Return 500: Request timeout]
    CheckErrorType -->|Aborted| Return499[Return 499: Request cancelled]
    CheckErrorType -->|Connection Closed| ReturnConnectionError[Return 500: Connection closed]
    CheckErrorType -->|Other| LogError[Log Error]

    LogError --> Unregister3[unregisterActiveRequest]
    Unregister3 --> Return500[Return 500: Internal Server Error]

    Return400 --> End([End])
    Return400Step0 --> End
    Return409 --> End
    ReturnApproval --> End
    ReturnSuccess --> End
    ReturnTimeout --> End
    Return499 --> End
    ReturnConnectionError --> End
    Return500 --> End

    ThrowConnectionError --> CatchBlock
    ThrowAborted --> CatchBlock
