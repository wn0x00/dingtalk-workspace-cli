package apiclient

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// NewManagedClient preserves the logical DingTalk API target while sending
// requests only to the configured proxy. The proxy owns all authentication.
func NewManagedClient(proxyBase, apiBase string) (*APIClient, error) {
	base, err := url.Parse(strings.TrimSpace(proxyBase))
	if err != nil || base == nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, fmt.Errorf("托管 OpenAPI 代理地址无效")
	}
	if base.Scheme != "https" {
		ip := net.ParseIP(base.Hostname())
		if base.Scheme != "http" || (base.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback())) {
			return nil, fmt.Errorf("托管 OpenAPI 代理必须使用 HTTPS；HTTP 只允许本机回环地址")
		}
	}
	client := NewClient("", apiBase)
	client.managed = true
	client.HTTPClient.Transport = &managedProxyTransport{base: base, next: defaultTransport()}
	client.HTTPClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return fmt.Errorf("托管 OpenAPI 不允许重定向")
	}
	return client, nil
}

// ValidateManagedTarget retains the upstream host boundary and disallows
// credential overrides or credential exchange on a business-resource route.
func ValidateManagedTarget(target string) error {
	if err := ValidateTargetHost(target); err != nil {
		return err
	}
	u, err := url.Parse(target)
	if err != nil {
		return fmt.Errorf("托管 OpenAPI 目标地址无效")
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return fmt.Errorf("托管 OpenAPI 查询参数无效")
	}
	for key := range query {
		if isManagedCredentialKey(key) {
			return fmt.Errorf("托管 OpenAPI 不允许通过查询参数提供凭据")
		}
	}
	path := strings.ToLower(u.Path)
	// Reject encoded path ambiguity instead of allowing different proxy layers
	// to interpret a credential endpoint or traversal differently.
	if strings.ContainsAny(path, "\\%?#") || strings.Contains(path, "//") {
		return fmt.Errorf("托管 OpenAPI 路径存在歧义")
	}
	for _, char := range path {
		if char < 0x20 || char == 0x7f {
			return fmt.Errorf("托管 OpenAPI 路径存在控制字符")
		}
	}
	if strings.HasPrefix(path, "/service/get_") && strings.Contains(strings.TrimPrefix(path, "/service/get_"), "token") {
		return fmt.Errorf("托管 OpenAPI 不允许访问 Token/OAuth 端点")
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "." || segment == ".." {
			return fmt.Errorf("托管 OpenAPI 不允许路径遍历")
		}
		if strings.HasPrefix(segment, "oauth") {
			return fmt.Errorf("托管 OpenAPI 不允许访问 Token/OAuth 端点")
		}
		switch segment {
		case "sns", "gettoken", "get_access_token", "get_corp_token", "get_suite_token", "get_permanent_code":
			return fmt.Errorf("托管 OpenAPI 不允许访问 Token/OAuth 端点")
		}
	}
	return nil
}

// ValidateManagedParams also protects dry-run rendering from credential input.
func ValidateManagedParams(params map[string]any) error {
	for key := range params {
		if isManagedCredentialKey(key) {
			return fmt.Errorf("托管 OpenAPI 不允许通过查询参数提供凭据")
		}
	}
	return nil
}

func isManagedCredentialKey(key string) bool {
	switch strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(key)) {
	case "token", "accesstoken", "useraccesstoken", "refreshtoken", "authorization", "appkey", "appsecret", "clientid", "clientsecret", "authtoken", "authid", "suitetoken", "suiteticket", "permanentcode", "password", "passwd", "secret", "cookie", "apikey":
		return true
	}
	return false
}

type managedProxyTransport struct {
	base *url.URL
	next http.RoundTripper
}

func (t *managedProxyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := ValidateManagedTarget(req.URL.String()); err != nil {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, err
	}
	kind := "api"
	if IsLegacyAPI(req.URL.String()) {
		kind = "oapi"
	}
	forwarded := req.Clone(req.Context())
	target := *t.base
	prefix := strings.TrimRight(t.base.Path, "/") + "/openapi/" + kind
	target.Path = prefix + req.URL.Path
	target.RawPath = strings.TrimRight(t.base.EscapedPath(), "/") + "/openapi/" + kind + req.URL.EscapedPath()
	target.RawQuery = req.URL.RawQuery
	forwarded.URL = &target
	forwarded.Host = ""
	forwarded.Header = make(http.Header)
	for _, name := range []string{"Content-Type", "Accept", "User-Agent"} {
		if value := req.Header.Get(name); value != "" {
			forwarded.Header.Set(name, value)
		}
	}
	// No credentials, identity overrides, redirects, retries or direct fallback.
	return t.next.RoundTrip(forwarded)
}
