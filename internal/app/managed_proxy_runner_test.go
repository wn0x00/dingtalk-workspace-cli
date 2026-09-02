package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DingTalk-Real-AI/dingtalk-workspace-cli/internal/audit"
	"github.com/DingTalk-Real-AI/dingtalk-workspace-cli/internal/executor"
	"github.com/DingTalk-Real-AI/dingtalk-workspace-cli/internal/transport"
	"github.com/DingTalk-Real-AI/dingtalk-workspace-cli/pkg/edition"
)

func TestManagedProxyInvocationSkipsOAuthAndSendsNoTokenHeaders(t *testing.T) {
	previousHooks := edition.Get()
	previousResolve := runnerResolveAuthSnapshot
	t.Cleanup(func() {
		edition.Override(previousHooks)
		runnerResolveAuthSnapshot = previousResolve
	})

	const productID = "managed-proxy-test"
	var endpoint string
	requestSeen := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestSeen = true
		if r.URL.Path != "/adapter/server/test" {
			t.Errorf("request path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("Authorization header leaked: %q", got)
		}
		if got := r.Header.Get("x-user-access-token"); got != "" {
			t.Errorf("x-user-access-token header leaked: %q", got)
		}
		var request struct {
			JSONRPC string `json:"jsonrpc"`
			ID      int    `json:"id"`
			Method  string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if request.JSONRPC != "2.0" || request.Method != "tools/call" {
			t.Errorf("unexpected RPC request: %#v", request)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      request.ID,
			"result": map[string]any{
				"content":           []map[string]any{{"type": "text", "text": "ok"}},
				"structuredContent": map[string]any{"items": []any{}},
			},
		})
	}))
	defer server.Close()
	endpoint = server.URL + "/adapter/server/test"

	edition.Override(&edition.Hooks{
		AllowAnonymousMCP: func(product, candidate string) bool {
			return product == productID && candidate == endpoint
		},
	})
	tokenResolverCalled := false
	runnerResolveAuthSnapshot = func(*runtimeRunner, context.Context) (AccessTokenSnapshot, error) {
		tokenResolverCalled = true
		return AccessTokenSnapshot{}, errors.New("OAuth resolver must not run")
	}

	runner := &runtimeRunner{
		transport:   transport.NewClient(server.Client()),
		globalFlags: &GlobalFlags{},
		auditSink:   audit.NopSink{},
	}
	result, err := runner.executeInvocation(context.Background(), endpoint, executor.Invocation{
		Kind:             "helper_invocation",
		CanonicalProduct: productID,
		Tool:             "list_records",
		Params:           map[string]any{},
	})
	if err != nil {
		t.Fatalf("managed proxy invocation: %v", err)
	}
	if tokenResolverCalled {
		t.Fatal("managed proxy invocation called the local OAuth resolver")
	}
	if !requestSeen || !result.Invocation.Implemented {
		t.Fatalf("request seen=%v result=%#v", requestSeen, result)
	}
}

func TestManagedProxyDisablesEndpointOverridesAndOwnsDevapp(t *testing.T) {
	previousHooks := edition.Get()
	t.Cleanup(func() { edition.Override(previousHooks) })
	t.Setenv("DINGTALK_DEVAPP_MCP_URL", "https://attacker.invalid/server/devapp")
	t.Setenv("DINGTALK_AITABLE_MCP_URL", "https://attacker.invalid/server/aitable")

	const (
		devappEndpoint  = "https://adapter.example.com/mcp/server/op-app"
		aitableEndpoint = "https://adapter.example.com/mcp/server/aitable"
	)
	edition.Override(&edition.Hooks{
		DisableMCPURLOverrides: true,
		StaticServers: func() []edition.ServerInfo {
			return []edition.ServerInfo{{ID: "aitable", Endpoint: aitableEndpoint}}
		},
		SupplementServers: func() []edition.ServerInfo {
			return []edition.ServerInfo{{ID: "devapp", Endpoint: devappEndpoint}}
		},
		AllowAnonymousMCP: func(product, endpoint string) bool {
			return (product == "aitable" && endpoint == aitableEndpoint) ||
				(product == "devapp" && endpoint == devappEndpoint)
		},
	})

	if got, ok := directRuntimeEndpoint("aitable", "list_records"); !ok || got != aitableEndpoint {
		t.Fatalf("aitable endpoint = %q, %v", got, ok)
	}
	if got, ok := directRuntimeEndpoint("devapp", "list_apps"); !ok || got != devappEndpoint {
		t.Fatalf("devapp endpoint = %q, %v", got, ok)
	}
	if hasDirectRuntimeEndpointOverride("aitable") {
		t.Fatal("managed proxy accepted a product endpoint override")
	}
}

func TestManagedProxyUnauthorizedDoesNotInvokeLocalAuthRecovery(t *testing.T) {
	previousHooks := edition.Get()
	previousResolve := runnerResolveAuthSnapshot
	previousCall := runnerCallTool
	previousRefresh := runnerForceRefreshRejectedAccessToken
	t.Cleanup(func() {
		edition.Override(previousHooks)
		runnerResolveAuthSnapshot = previousResolve
		runnerCallTool = previousCall
		runnerForceRefreshRejectedAccessToken = previousRefresh
	})

	const endpoint = "https://adapter.example.com/mcp/server/aitable"
	onAuthErrorCalls := 0
	refreshCalls := 0
	edition.Override(&edition.Hooks{
		AllowAnonymousMCP: func(product, candidate string) bool {
			return product == "aitable" && candidate == endpoint
		},
		OnAuthError: func(string, error) error {
			onAuthErrorCalls++
			return errors.New("must not recover local OAuth")
		},
	})
	runnerResolveAuthSnapshot = func(*runtimeRunner, context.Context) (AccessTokenSnapshot, error) {
		return AccessTokenSnapshot{}, errors.New("must not resolve local OAuth")
	}
	runnerForceRefreshRejectedAccessToken = func(context.Context, string, string) (string, error) {
		refreshCalls++
		return "", errors.New("must not refresh local OAuth")
	}
	wantErr := errors.New("adapter rejected request")
	runnerCallTool = func(*transport.Client, context.Context, string, string, map[string]any) (transport.ToolCallResult, error) {
		return transport.ToolCallResult{}, wantErr
	}

	runner := &runtimeRunner{
		transport:   transport.NewClient(nil),
		globalFlags: &GlobalFlags{},
		auditSink:   audit.NopSink{},
	}
	_, err := runner.executeInvocation(context.Background(), endpoint, executor.Invocation{
		CanonicalProduct: "aitable",
		Tool:             "list_records",
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("managed proxy error = %v", err)
	}
	if onAuthErrorCalls != 0 || refreshCalls != 0 {
		t.Fatalf("local auth recovery calls: on-error=%d refresh=%d", onAuthErrorCalls, refreshCalls)
	}
}
