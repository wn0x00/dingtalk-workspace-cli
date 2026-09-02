package edition

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestConfigureManagedProxyHooksRewritesAndOwnsExactEndpoints(t *testing.T) {
	t.Setenv(DingTalkCLIBaseURLEnv, "https://adapter.example.com/v1/dingtalk/mcp/")
	base := &Hooks{
		Name: "open",
		StaticServers: func() []ServerInfo {
			return []ServerInfo{
				{ID: "aitable", Name: "AI 表格", Endpoint: "https://mcp-gw.dingtalk.com/server/aitable", Prefixes: []string{"base"}},
			}
		},
		SupplementServers: func() []ServerInfo {
			return []ServerInfo{{ID: "mcp-meta", Endpoint: "https://mcp-gw.dingtalk.com/server/meta"}}
		},
	}

	hooks := configureManagedProxyHooks(base)
	if hooks.Name != managedProxyName || !hooks.HideAuthLogin || !hooks.DisableMCPURLOverrides {
		t.Fatalf("managed hooks = name %q hide %v disable overrides %v", hooks.Name, hooks.HideAuthLogin, hooks.DisableMCPURLOverrides)
	}
	if hooks.TokenProvider != nil || hooks.OnAuthError != nil || hooks.AllowAnonymousMCP == nil {
		t.Fatalf("managed auth hooks = token %v on-error %v anonymous %v", hooks.TokenProvider != nil, hooks.OnAuthError != nil, hooks.AllowAnonymousMCP != nil)
	}

	static := hooks.StaticServers()
	if got := static[0].Endpoint; got != "https://adapter.example.com/v1/dingtalk/mcp/server/aitable" {
		t.Fatalf("aitable endpoint = %q", got)
	}
	supplement := hooks.SupplementServers()
	wantSupplement := map[string]string{
		"mcp-meta": "https://adapter.example.com/v1/dingtalk/mcp/server/meta",
		"devapp":   "https://adapter.example.com/v1/dingtalk/mcp/server/op-app",
	}
	for _, server := range supplement {
		if want, ok := wantSupplement[server.ID]; ok {
			if server.Endpoint != want {
				t.Fatalf("%s endpoint = %q", server.ID, server.Endpoint)
			}
			delete(wantSupplement, server.ID)
		}
	}
	if len(wantSupplement) != 0 {
		t.Fatalf("missing supplement servers: %#v", wantSupplement)
	}

	if !hooks.AllowAnonymousMCP("aitable", static[0].Endpoint) {
		t.Fatal("exact managed endpoint was not authorized")
	}
	if hooks.AllowAnonymousMCP("aitable", "https://attacker.invalid/server/aitable") {
		t.Fatal("unowned endpoint was authorized")
	}
	if hooks.AllowAnonymousMCP("unknown", static[0].Endpoint) {
		t.Fatal("unowned product was authorized")
	}

	static[0].Endpoint = "mutated"
	static[0].Prefixes[0] = "mutated"
	fresh := hooks.StaticServers()
	if fresh[0].Endpoint == "mutated" || fresh[0].Prefixes[0] == "mutated" {
		t.Fatal("caller mutation escaped the server clone")
	}
}

func TestManagedProxyBaseURLValidation(t *testing.T) {
	for _, tc := range []struct {
		name    string
		value   string
		wantErr string
	}{
		{name: "https-remote", value: "https://adapter.example.com/proxy"},
		{name: "http-loopback-ip", value: "http://127.0.0.1:18766/proxy"},
		{name: "http-localhost", value: "http://localhost:18766/proxy"},
		{name: "http-remote", value: "http://adapter.example.com/proxy", wantErr: "https"},
		{name: "userinfo", value: "https://user:secret@adapter.example.com/proxy", wantErr: "用户名"},
		{name: "query", value: "https://adapter.example.com/proxy?authId=secret", wantErr: "查询参数"},
		{name: "unsupported", value: "ftp://adapter.example.com/proxy", wantErr: "http"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseManagedProxyBaseURL(tc.value)
			if tc.wantErr == "" {
				if err != nil || got == nil {
					t.Fatalf("parse = %#v, %v", got, err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestConfigureManagedProxyHooksFailsClosedOnInvalidBase(t *testing.T) {
	t.Setenv(DingTalkCLIBaseURLEnv, "http://adapter.example.com/proxy")
	hooks := configureManagedProxyHooks(&Hooks{
		StaticServers: func() []ServerInfo {
			return []ServerInfo{{ID: "aitable", Endpoint: "https://mcp-gw.dingtalk.com/server/aitable"}}
		},
	})
	if hooks.AllowAnonymousMCP != nil || len(hooks.StaticServers()) != 0 {
		t.Fatal("invalid proxy configuration did not fail closed")
	}
	root, leaf := managedProxyCommandTree("aitable")
	_ = root
	if err := hooks.AfterPersistentPreRun(leaf, nil); err == nil || !strings.Contains(err.Error(), DingTalkCLIBaseURLEnv) {
		t.Fatalf("configuration error = %v", err)
	}
}

func TestValidateManagedProxyInvocationBlocksCredentialAndNonMCPPaths(t *testing.T) {
	for _, tc := range []struct {
		name    string
		command string
		flag    string
		value   string
	}{
		{name: "token", command: "aitable", flag: "token", value: "caller-token"},
		{name: "profile-flag", command: "aitable", flag: "profile", value: "caller-profile"},
		{name: "client-id", command: "aitable", flag: "client-id", value: "caller-client"},
		{name: "client-secret", command: "aitable", flag: "client-secret", value: "caller-secret"},
		{name: "auth", command: "auth"},
		{name: "profile", command: "profile"},
		{name: "api", command: "api"},
		{name: "mcp", command: "mcp"},
		{name: "event", command: "event"},
		{name: "upgrade", command: "upgrade"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, leaf := managedProxyCommandTree(tc.command)
			if tc.flag != "" {
				if err := root.PersistentFlags().Set(tc.flag, tc.value); err != nil {
					t.Fatal(err)
				}
			}
			err := validateManagedProxyInvocation(leaf)
			if err == nil {
				t.Fatal("managed proxy bypass was accepted")
			}
			if tc.value != "" && strings.Contains(err.Error(), tc.value) {
				t.Fatal("credential value leaked in validation error")
			}
		})
	}

	_, business := managedProxyCommandTree("aitable")
	if err := validateManagedProxyInvocation(business); err != nil {
		t.Fatalf("business command was rejected: %v", err)
	}

	for _, name := range []string{"get", "search", "install"} {
		root, skill := managedProxyCommandTree("skill")
		leaf := &cobra.Command{Use: name}
		skill.AddCommand(leaf)
		_ = root
		if err := validateManagedProxyInvocation(leaf); err == nil {
			t.Fatalf("remote skill command %q was accepted", name)
		}
	}
	root, skill := managedProxyCommandTree("skill")
	setup := &cobra.Command{Use: "setup"}
	skill.AddCommand(setup)
	_ = root
	if err := validateManagedProxyInvocation(setup); err != nil {
		t.Fatalf("local skill setup was rejected: %v", err)
	}
}

func managedProxyCommandTree(topName string) (*cobra.Command, *cobra.Command) {
	root := &cobra.Command{Use: "dws"}
	for _, name := range []string{"token", "profile", "client-id", "client-secret"} {
		root.PersistentFlags().String(name, "", "")
	}
	top := &cobra.Command{Use: topName}
	leaf := &cobra.Command{Use: "leaf"}
	top.AddCommand(leaf)
	root.AddCommand(top)
	return root, leaf
}
