flowchart TD
    Start([🚀 Test Execution Starts]) --> Execute[IntelligentTestOrchestrator.execute<br/>🔵 Core Orchestrator]

    Execute --> Setup[Setup Phase<br/>🔵 Initialize Services]
    Setup --> MainLoop[MainLoopService.execute<br/>🔵 Main Loop]

    MainLoop --> LoopStart{🔄 Main Loop Iteration}

    LoopStart --> AnalyzePage[analyzePage<br/>🔵 Page Analysis]
    AnalyzePage --> PageAnalyzer[IntelligentPageAnalyzer.analyzePage<br/>🔵 Page Analyzer]

    PageAnalyzer --> WaitSPA[waitForSPALoad<br/>🔵 Wait SPA]
    WaitSPA --> CaptureScreenshot[captureScreenshot<br/>🔵 Screenshot]
    CaptureScreenshot --> WaitModals[waitForModals<br/>🔵 Wait Modals]
    WaitModals --> AnalyzeDOM[analyzeDOMFull<br/>🔵 DOM Analysis]
    AnalyzeDOM --> EnhanceDOM[enhanceDOMWithAISelectors<br/>🔵 Enhance DOM]
    EnhanceDOM --> VisionCheck{Should Use Vision?}

    VisionCheck -->|Yes| AnalyzeVision[analyzeWithVision<br/>🔴 Enhanced Prompt]
    VisionCheck -->|No| AnalyzeWithoutVision[analyzeWithoutVision<br/>🔵 Fallback]

    AnalyzeVision --> MatchVision[matchVisionElementsWithDOMSelectors<br/>🔵 Match Elements]
    AnalyzeWithoutVision --> MatchVision
    MatchVision --> EnhanceModals[enhanceDOMWithVisionModals<br/>🔵 Enhance Modals]
    EnhanceModals --> AnalyzeLogic[analyzeLogic<br/>🔵 Logic Analysis]
    AnalyzeLogic --> BuildContext[Build PageContext<br/>🔵 Context Builder]

    BuildContext --> GenerateActions[generateActions<br/>🔵 Generate Actions]
    GenerateActions --> ActionGenerator[ContextualActionGenerator.generateActions<br/>🔵 Action Generator]

    ActionGenerator --> ValidateCache[validateCachedActions<br/>🔵 Validate Cache]
    ValidateCache --> BuildHistory[buildHistorySummary<br/>🔵 Build History]
    BuildHistory --> BuildElements[buildElementsSummary<br/>🔵 Build Elements]
    BuildElements --> BuildDOM[buildDOMSummary<br/>🔵 Build DOM]
    BuildDOM --> GetHTML[getPageHTML<br/>🔵 Get HTML]
    GetHTML --> MaskPII[maskPII<br/>🔴 Enhanced PII Masking]
    MaskPII --> ParseJSON[parseRobustJSON<br/>🔴 Enhanced JSON Parsing]
    ParseJSON --> Sanitize[sanitizeActions<br/>🔵 Sanitize]
    Sanitize --> ReturnActions[Return Actions<br/>🔵 Return]

    ReturnActions --> ExecuteActions[executeActions<br/>🟡 Refactored]
    ExecuteActions --> ExecuteSingle[executeSingleAction<br/>🟢 NEW: Main Action Orchestrator]

    ExecuteSingle --> PreAnalysis[handlePreActionAnalysis<br/>🟢 NEW: Pre-Action Handler]
    PreAnalysis --> PreActionAnalyzer[PreActionAnalyzer.analyzeBeforeAction<br/>🔵 Pre-Action Analyzer]
    PreActionAnalyzer --> LogPrereq[logPrerequisiteAction<br/>🟢 NEW: Logging Helper]
    LogPrereq --> ValidateSelector[validateAndPrepareSelector<br/>🟢 NEW: Selector Validator]
    ValidateSelector --> SelfHealing[SelfHealingService.healSelector<br/>🔵 Self-Healing]
    SelfHealing --> CaptureBefore[captureActionScreenshots<br/>🟢 NEW: Screenshot Helper]
    CaptureBefore --> ExecuteCommand[executeActionCommand<br/>🟢 NEW: Command Executor]

    ExecuteCommand --> LogExecution[logActionExecution<br/>🟢 NEW: Logging Helper]
    LogExecution --> CommandExec[CommandExecutor.executeCommand<br/>🔵 Command Executor]
    CommandExec --> WaitEffect[waitForActionEffect<br/>🟢 NEW: Wait Effect]
    WaitEffect --> HandleAsync[handleAsyncOperations<br/>🟢 NEW: Async Handler]
    HandleAsync --> EnsureComplete[ensureActionCompleted<br/>🟢 NEW: Ensure Complete]
    EnsureComplete --> VerifySuccess[verifyActionSuccess<br/>🟢 NEW: Verify Success]
    VerifySuccess --> CaptureAfter[captureActionScreenshots<br/>🟢 NEW: Screenshot Helper]

    CaptureAfter --> ValidateResult[ResultValidator.validateResult<br/>🔵 Result Validator]
    ValidateResult --> PostAnalysis[handlePostActionAnalysisMethod<br/>🟢 NEW: Post-Action Handler]
    PostAnalysis --> PostActionAnalyzer[PostActionAnalyzer.analyze<br/>🔵 Post-Action Analyzer]
    PostActionAnalyzer --> LogPost[logPostActionAnalysis<br/>🟢 NEW: Logging Helper]

    PostAnalysis --> CheckState[checkElementStateAfterAction<br/>🟢 NEW: Check State]
    CheckState --> DetectChanges[detectPageChanges<br/>🟢 NEW: Detect Changes]
    DetectChanges --> HandleError{Action Failed?}

    HandleError -->|Yes| HandleFailure[handleActionFailure<br/>🟢 NEW: Failure Handler]
    HandleFailure --> CreateErrorCtx[createActionErrorContext<br/>🟢 NEW: Error Context]
    CreateErrorCtx --> LogError[logActionError<br/>🟢 NEW: Logging Helper]
    LogError --> ShouldRetry{shouldRetryAction?<br/>🟢 NEW: Retry Check}
    ShouldRetry -->|Yes| ExecuteSingle
    ShouldRetry -->|No| NextAction

    HandleError -->|No| NextAction[Next Action<br/>🔵 Next]
    NextAction --> DecideNext[decideNextStep<br/>🔵 Decide Next]
    DecideNext --> ContextualDecide[ContextualActionGenerator.decideNextStep<br/>🔵 Contextual Decide]
    ContextualDecide --> ParseDecision[parseRobustJSON<br/>🔴 Enhanced JSON Parsing]
    ParseDecision --> DecisionCheck{Decision Type}

    DecisionCheck -->|continue| LoopStart
    DecisionCheck -->|stop| BuildResult[buildResult<br/>🔵 Build Result]
    DecisionCheck -->|wait_for_user| WaitUser[Wait for User<br/>🔵 Wait]
    DecisionCheck -->|retry| RetryAction[Retry Action<br/>🔵 Retry]
    DecisionCheck -->|skip| SkipAction[Skip Action<br/>🔵 Skip]

    RetryAction --> ExecuteSingle
    SkipAction --> NextAction
    WaitUser --> BuildResult

    BuildResult --> ValidateTest[validateTestResult<br/>🔵 Validate Test]
    ValidateTest --> BuildSummary[buildSummary<br/>🔵 Build Summary]
    BuildSummary --> UploadGraph[uploadGraphScreenshotsToStorage<br/>🔵 Upload Graph]
    UploadGraph --> End([✅ Test Complete])

    style Execute fill:#e1f5ff,stroke:#01579b,stroke-width:2px
    style ExecuteSingle fill:#fff4e1,stroke:#e65100,stroke-width:3px
    style PreAnalysis fill:#fff4e1,stroke:#e65100,stroke-width:3px
    style ValidateSelector fill:#fff4e1,stroke:#e65100,stroke-width:3px
    style ExecuteCommand fill:#fff4e1,stroke:#e65100,stroke-width:3px
    style VerifySuccess fill:#fff4e1,stroke:#e65100,stroke-width:3px
    style PostAnalysis fill:#fff4e1,stroke:#e65100,stroke-width:3px
    style HandleFailure fill:#fff4e1,stroke:#e65100,stroke-width:3px
    style ExecuteActions fill:#fff4e1,stroke:#e65100,stroke-width:3px

    style LogExecution fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style LogError fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style LogPrereq fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style LogPost fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style CreateErrorCtx fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style ShouldRetry fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style WaitEffect fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style HandleAsync fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style EnsureComplete fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style CheckState fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style DetectChanges fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style CaptureBefore fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style CaptureAfter fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px

    style ParseJSON fill:#ffebee,stroke:#c62828,stroke-width:2px
    style MaskPII fill:#ffebee,stroke:#c62828,stroke-width:2px
    style AnalyzeVision fill:#ffebee,stroke:#c62828,stroke-width:2px
    style ParseDecision fill:#ffebee,stroke:#c62828,stroke-width:2px
