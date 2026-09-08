// Copyright 2026 Alibaba Group
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package edition

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

const (
	// DingTalkCLIBaseURLEnv enables the managed iPaaS proxy route. The proxy is
	// responsible for selecting the current sandbox user's server-side authId
	// and DingTalk OAuth credential; DWS never receives either value.
	DingTalkCLIBaseURLEnv = "DINGTALK_CLI_BASE_URL"
	managedProxyName      = "ipass-proxy"
)

func configureManagedProxyHooks(base *Hooks) *Hooks {
	if base == nil {
		base = &Hooks{}
	}
	rawBase := strings.TrimSpace(os.Getenv(DingTalkCLIBaseURLEnv))
	if rawBase == "" {
		return base
	}

	hooks := *base
	hooks.Name = managedProxyName
	hooks.HideAuthLogin = true
	hooks.DisableMCPURLOverrides = true

	proxyBase, err := parseManagedProxyBaseURL(rawBase)
	if err != nil {
		return managedProxyConfigurationError(&hooks, err)
	}
	if hooks.StaticServers == nil {
		return managedProxyConfigurationError(&hooks, errors.New("基础版本没有静态 MCP 服务清单"))
	}

	staticServers, err := rewriteManagedProxyServers(proxyBase, hooks.StaticServers())
	if err != nil {
		return managedProxyConfigurationError(&hooks, err)
	}
	if len(staticServers) == 0 {
		return managedProxyConfigurationError(&hooks, errors.New("基础版本返回了空的 MCP 服务清单"))
	}

	var supplementServers []ServerInfo
	if hooks.SupplementServers != nil {
		supplementServers, err = rewriteManagedProxyServers(proxyBase, hooks.SupplementServers())
		if err != nil {
			return managedProxyConfigurationError(&hooks, err)
		}
	}
	devappEndpoint, err := appendManagedProxyPath(proxyBase, "/server/op-app")
	if err != nil {
		return managedProxyConfigurationError(&hooks, err)
	}
	supplementServers = upsertManagedProxyServer(supplementServers, ServerInfo{
		ID:       "devapp",
		Name:     "钉钉开放平台应用管理",
		Endpoint: devappEndpoint,
	})

	allowedEndpoints := managedProxyEndpointAllowlist(staticServers, supplementServers)
	allowedCommands := managedProxyBusinessCommands(staticServers, supplementServers)
	visibleProducts := serverIDs(staticServers)
	previousPreRun := hooks.AfterPersistentPreRun
	hooks.StaticServers = func() []ServerInfo { return cloneServers(staticServers) }
	hooks.SupplementServers = func() []ServerInfo { return cloneServers(supplementServers) }
	hooks.VisibleProducts = func() []string { return append([]string(nil), visibleProducts...) }
	hooks.AllowAnonymousMCP = func(productID, endpoint string) bool {
		endpoints := allowedEndpoints[strings.TrimSpace(productID)]
		return endpoints != nil && endpoints[endpoint]
	}
	// StaticServers is authoritative in this distribution. Clear discovery
	// hooks so an unavailable or changing Market cannot introduce a second
	// network route.
	hooks.DiscoveryURL = ""
	hooks.DiscoveryHeaders = nil
	hooks.FallbackServers = nil
	hooks.TokenProvider = nil
	hooks.OnAuthError = nil
	hooks.EnterpriseCredentialHeaders = nil
	hooks.AfterPersistentPreRun = managedProxyPreRun(previousPreRun, nil, allowedCommands)
	return &hooks
}

func managedProxyConfigurationError(hooks *Hooks, configErr error) *Hooks {
	hooks.StaticServers = func() []ServerInfo { return nil }
	hooks.SupplementServers = func() []ServerInfo { return nil }
	hooks.VisibleProducts = func() []string { return nil }
	hooks.AllowAnonymousMCP = nil
	hooks.TokenProvider = nil
	hooks.OnAuthError = nil
	hooks.EnterpriseCredentialHeaders = nil
	hooks.DiscoveryURL = ""
	hooks.DiscoveryHeaders = nil
	hooks.FallbackServers = nil
	hooks.AfterPersistentPreRun = managedProxyPreRun(hooks.AfterPersistentPreRun, fmt.Errorf("%s 配置无效: %w", DingTalkCLIBaseURLEnv, configErr), nil)
	return hooks
}

func parseManagedProxyBaseURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("必须使用 http 或 https")
	}
	if parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("必须是无用户名、密码、查询参数和片段的服务地址")
	}
	if parsed.Scheme == "http" {
		host := parsed.Hostname()
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return nil, errors.New("远程服务必须使用 https；http 只允许本机回环地址")
		}
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = ""
	return parsed, nil
}

func rewriteManagedProxyServers(proxyBase *url.URL, source []ServerInfo) ([]ServerInfo, error) {
	result := make([]ServerInfo, 0, len(source))
	for _, server := range source {
		upstream, err := url.Parse(strings.TrimSpace(server.Endpoint))
		if err != nil || upstream.Scheme == "" || upstream.Host == "" {
			return nil, fmt.Errorf("服务 %q 的 MCP 地址无效", server.ID)
		}
		if upstream.Scheme != "http" && upstream.Scheme != "https" {
			return nil, fmt.Errorf("服务 %q 使用了不支持的 MCP 协议", server.ID)
		}
		if upstream.RawQuery != "" || upstream.Fragment != "" {
			return nil, fmt.Errorf("服务 %q 的 MCP 地址不能包含查询参数或片段", server.ID)
		}
		endpoint, err := appendManagedProxyPath(proxyBase, upstream.Path)
		if err != nil {
			return nil, fmt.Errorf("改写服务 %q 的 MCP 地址: %w", server.ID, err)
		}
		result = append(result, ServerInfo{
			ID:       server.ID,
			Name:     server.Name,
			Endpoint: endpoint,
			Prefixes: append([]string(nil), server.Prefixes...),
		})
	}
	return result, nil
}

func appendManagedProxyPath(proxyBase *url.URL, upstreamPath string) (string, error) {
	if proxyBase == nil {
		return "", errors.New("代理服务地址为空")
	}
	cleanPath := "/" + strings.TrimLeft(strings.TrimSpace(upstreamPath), "/")
	if cleanPath == "/" || (!strings.HasPrefix(cleanPath, "/server/") && cleanPath != "/server") {
		return "", fmt.Errorf("上游 MCP 路径 %q 不在 /server 下", upstreamPath)
	}
	endpoint := *proxyBase
	endpoint.Path = strings.TrimRight(proxyBase.Path, "/") + cleanPath
	endpoint.RawPath = ""
	endpoint.RawQuery = ""
	endpoint.Fragment = ""
	return endpoint.String(), nil
}

func upsertManagedProxyServer(servers []ServerInfo, replacement ServerInfo) []ServerInfo {
	for i := range servers {
		if strings.TrimSpace(servers[i].ID) == replacement.ID {
			servers[i] = replacement
			return servers
		}
	}
	return append(servers, replacement)
}

func managedProxyEndpointAllowlist(groups ...[]ServerInfo) map[string]map[string]bool {
	result := make(map[string]map[string]bool)
	for _, servers := range groups {
		for _, server := range servers {
			id := strings.TrimSpace(server.ID)
			if id == "" || strings.TrimSpace(server.Endpoint) == "" {
				continue
			}
			if result[id] == nil {
				result[id] = make(map[string]bool)
			}
			result[id][server.Endpoint] = true
		}
	}
	return result
}

func managedProxyPreRun(previous func(*cobra.Command, []string) error, configErr error, allowedCommands map[string]bool) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		if configErr != nil {
			return configErr
		}
		if err := validateManagedProxyInvocationWithAllowedCommands(cmd, allowedCommands); err != nil {
			return err
		}
		if previous != nil {
			return previous(cmd, args)
		}
		return nil
	}
}

func validateManagedProxyInvocation(cmd *cobra.Command) error {
	return validateManagedProxyInvocationWithAllowedCommands(cmd, managedProxyBusinessCommands(openStaticServers(), openSupplementServers()))
}

func validateManagedProxyInvocationWithAllowedCommands(cmd *cobra.Command, allowedCommands map[string]bool) error {
	for _, name := range []string{"token", "profile"} {
		if rootFlagProvided(cmd, name) {
			return fmt.Errorf("iPaaS 托管模式不允许使用 --%s", name)
		}
	}
	for _, name := range []string{"client-id", "client-secret"} {
		if strings.TrimSpace(rootFlagValue(cmd, name)) != "" {
			return fmt.Errorf("iPaaS 托管模式不允许使用 --%s", name)
		}
	}
	if top := topLevelCommand(cmd); top != nil {
		// Only the fixed MCP products owned by this managed edition may run.
		// Utility commands are deliberately not a deny-list: a newly added local
		// command must be rejected by default until it is explicitly backed by a
		// reviewed proxy endpoint. `schema` is the sole local read-only exception;
		// OC skills use it to discover the argument contract of an allowed product.
		if top.Name() == "schema" {
			return nil
		}
		if managedProxyLocalCommands[top.Name()] {
			return fmt.Errorf("iPaaS 托管模式不提供本地 dws %s 命令", top.Name())
		}
		if allowedCommands[top.Name()] {
			return nil
		}
		return fmt.Errorf("iPaaS 托管模式仅允许固定钉钉 MCP 业务命令；dws %s 不可用", top.Name())
	}
	return nil
}

// managedProxyLocalCommands are local management, credential, diagnostics and
// extension entry points. They remain blocked even when a business MCP server
// happens to use the same prefix (for example calendar's `event` prefix).
var managedProxyLocalCommands = map[string]bool{
	"api": true, "audit": true, "auth": true, "cache": true, "completion": true,
	"config": true, "doctor": true, "event": true, "mcp": true, "plugin": true,
	"profile": true, "recovery": true, "shortcut": true, "skill": true, "upgrade": true,
}

// managedProxyBusinessCommands derives command names from the exact static
// and supplemental endpoints that configureManagedProxyHooks has rewritten to
// OC. Prefixes are included because some compatibility commands address a
// product through its reviewed prefix rather than its canonical server ID.
func managedProxyBusinessCommands(groups ...[]ServerInfo) map[string]bool {
	allowed := make(map[string]bool)
	for _, servers := range groups {
		for _, server := range servers {
			if id := strings.TrimSpace(server.ID); id != "" {
				allowed[id] = true
			}
			for _, prefix := range server.Prefixes {
				if name := strings.TrimSpace(prefix); name != "" {
					allowed[name] = true
				}
			}
		}
	}
	return allowed
}

func topLevelCommand(cmd *cobra.Command) *cobra.Command {
	current := cmd
	for current != nil && current.Parent() != nil && current.Parent().Parent() != nil {
		current = current.Parent()
	}
	if current != nil && current.Parent() != nil {
		return current
	}
	return nil
}

func rootFlagProvided(cmd *cobra.Command, name string) bool {
	if cmd == nil || cmd.Root() == nil {
		return false
	}
	flag := cmd.Root().PersistentFlags().Lookup(name)
	return flag != nil && flag.Changed
}

func rootFlagValue(cmd *cobra.Command, name string) string {
	if cmd == nil || cmd.Root() == nil {
		return ""
	}
	flag := cmd.Root().PersistentFlags().Lookup(name)
	if flag == nil {
		return ""
	}
	return flag.Value.String()
}

func cloneServers(source []ServerInfo) []ServerInfo {
	result := make([]ServerInfo, len(source))
	for i, server := range source {
		result[i] = server
		result[i].Prefixes = append([]string(nil), server.Prefixes...)
	}
	return result
}

func serverIDs(servers []ServerInfo) []string {
	result := make([]string, 0, len(servers))
	seen := make(map[string]bool)
	for _, server := range servers {
		id := strings.TrimSpace(server.ID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		result = append(result, id)
	}
	return result
}
