package apiclient

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCrossPlatformCoverageManagedOpenAPIRoutesWithoutCredentials(t *testing.T) {
	for _, tc := range []struct{ target, route string }{
		{"/v1.0/contact/users/search", "/tenant/dingtalk/openapi/api/v1.0/contact/users/search"},
		{"https://oapi.dingtalk.com/topapi/v2/user/get", "/tenant/dingtalk/openapi/oapi/topapi/v2/user/get"},
		{"/v1.0/resources/a%20b", "/tenant/dingtalk/openapi/api/v1.0/resources/a%20b"},
	} {
		t.Run(tc.target, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.EscapedPath() != tc.route || r.URL.RawQuery != "page=2" || r.Method != "POST" {
					t.Errorf("request = %s %s", r.Method, r.URL.String())
				}
				for _, key := range []string{"Authorization", AuthHeader, "x-user-access-token", "Cookie", "x-auth-id"} {
					if r.Header.Get(key) != "" {
						t.Errorf("credential header %s leaked", key)
					}
				}
				body, _ := io.ReadAll(r.Body)
				if string(body) != `{"name":"测试"}` || r.Header.Get("Content-Type") != "application/json" {
					t.Errorf("body/content type lost: %q", body)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"value":1}`)
			}))
			defer server.Close()
			client, err := NewManagedClient(server.URL+"/tenant/dingtalk/", "")
			if err != nil {
				t.Fatal(err)
			}
			client.Token = "must-not-leak"
			resp, err := client.Do(context.Background(), RawAPIRequest{Method: "POST", Path: tc.target, Params: map[string]any{"page": 2}, Data: map[string]any{"name": "测试"}})
			if err != nil {
				t.Fatal(err)
			}
			defer resp.BodyReader.Close()
			body, _ := io.ReadAll(resp.BodyReader)
			if string(body) != `{"value":1}` {
				t.Fatalf("response = %s", body)
			}
		})
	}
}

func TestCrossPlatformCoverageManagedOpenAPIRejectsOverridesAndTokenEndpoints(t *testing.T) {
	for _, target := range []string{
		"https://api.dingtalk.com/v1.0/test?access_token=caller-secret",
		"https://api.dingtalk.com/v1.0/test?USER-ACCESS-TOKEN=caller-secret",
		"https://oapi.dingtalk.com/topapi/test?authId=caller-secret",
		"https://api.dingtalk.com/v1.0/oauth2/accessToken",
		"https://api.dingtalk.com/v1.0/oauth2/userAccessToken",
		"https://api.dingtalk.com/v1.0/%6fauth2/accessToken",
		"https://api.dingtalk.com/v1.0/%256fauth2/accessToken",
		"https://oapi.dingtalk.com/gettoken",
		"https://oapi.dingtalk.com/service/get_corp_token",
		"https://oapi.dingtalk.com/service/get_sso_token",
		"https://api.dingtalk.com/v1.0/test?Api-Key=caller-secret",
		"https://api.dingtalk.com/v1.0/resource%3fother",
		"https://api.dingtalk.com/v1.0/resource%00other",
		"https://oapi.dingtalk.com/sns/gettoken",
		"https://api.dingtalk.com/v1.0/%2e%2e/oauth2/accessToken",
		"https://attacker.invalid/v1.0/test",
	} {
		if err := ValidateManagedTarget(target); err == nil {
			t.Errorf("accepted %s", target)
		}
	}
	for _, base := range []string{"http://remote.example/proxy", "https://user:secret@example.com/proxy", "https://example.com/proxy?token=x", "file:///tmp/proxy"} {
		if _, err := NewManagedClient(base, ""); err == nil {
			t.Errorf("accepted base %s", base)
		}
	}
	client, _ := NewManagedClient("http://127.0.0.1:1", "")
	client.HTTPClient.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { t.Fatal("validation contacted network"); return nil, nil })
	if _, err := client.Do(context.Background(), RawAPIRequest{Method: "GET", Path: "/v1.0/test", Params: map[string]any{"access_token": "caller-secret"}}); err == nil || strings.Contains(err.Error(), "caller-secret") {
		t.Fatalf("credential validation = %v", err)
	}
}

func TestCrossPlatformCoverageManagedOpenAPINoRetryOrRedirect(t *testing.T) {
	for _, code := range []int{401, 403, 429, 500, 302, 307, 308} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Location", "/unexpected-redirect")
				w.WriteHeader(code)
				_, _ = io.WriteString(w, `{"code":"rejected"}`)
			}))
			defer server.Close()
			client, _ := NewManagedClient(server.URL, "")
			resp, err := client.Do(context.Background(), RawAPIRequest{Method: "POST", Path: "/v1.0/test", Data: map[string]any{"write": true}})
			if code >= 300 && code < 400 {
				if err == nil {
					t.Fatal("redirect accepted")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				defer resp.BodyReader.Close()
				if resp.StatusCode != code {
					t.Fatalf("status = %d", resp.StatusCode)
				}
			}
			if calls.Load() != 1 {
				t.Fatalf("calls = %d", calls.Load())
			}
		})
	}
}

func TestCrossPlatformCoverageManagedOpenAPIMultipart(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/openapi/oapi/media/upload" || r.URL.RawQuery != "" {
			t.Errorf("request URL = %s", r.URL.String())
		}
		if err := r.ParseMultipartForm(1024); err != nil {
			t.Error(err)
			return
		}
		defer r.MultipartForm.RemoveAll()
		file, _, err := r.FormFile("media")
		if err != nil {
			t.Error(err)
			return
		}
		defer file.Close()
		data, _ := io.ReadAll(file)
		if string(data) != "binary-data" || r.FormValue("type") != "image" {
			t.Error("multipart body changed")
		}
		_, _ = io.WriteString(w, `{"errcode":0}`)
	}))
	defer server.Close()
	client, _ := NewManagedClient(server.URL, LegacyBaseURL)
	resp, err := client.Do(context.Background(), RawAPIRequest{Method: "POST", Path: "/media/upload", Data: map[string]any{"type": "image"}, File: &FileUpload{FieldName: "media", FileName: "sample.png", Reader: strings.NewReader("binary-data")}})
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.BodyReader.Close()
}

func TestCrossPlatformCoverageManagedOpenAPITransportStripsHeaders(t *testing.T) {
	client, _ := NewManagedClient("https://adapter.example/proxy", "")
	transport := client.HTTPClient.Transport.(*managedProxyTransport)
	transport.next = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "adapter.example" || r.URL.Path != "/proxy/openapi/api/v1.0/test" {
			t.Errorf("request URL = %s", r.URL.String())
		}
		if len(r.Header) != 1 || r.Header.Get("Accept") != "application/json" {
			t.Errorf("headers = %#v", r.Header)
		}
		return jsonHTTPResponse(`{}`), nil
	})
	req, _ := http.NewRequest("GET", "https://api.dingtalk.com/v1.0/test", nil)
	for _, h := range []string{"Authorization", AuthHeader, "Cookie", "x-user-access-token", "x-auth-id"} {
		req.Header.Set(h, "must-not-leak")
	}
	req.Header.Set("Accept", "application/json")
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
}

func TestCrossPlatformCoverageManagedOpenAPIPagination(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := calls.Add(1)
		if r.URL.Path != "/proxy/openapi/api/v1.0/resources" || r.URL.Query().Get("access_token") != "" {
			t.Errorf("unexpected managed page URL = %s", r.URL.String())
		}
		w.Header().Set("Content-Type", "application/json")
		if page == 1 {
			_, _ = io.WriteString(w, `{"items":[1],"nextToken":"page-two","hasMore":true}`)
		} else {
			if r.URL.Query().Get("nextToken") != "page-two" {
				t.Error("continuation lost")
			}
			_, _ = io.WriteString(w, `{"items":[2],"hasMore":false}`)
		}
	}))
	defer server.Close()
	client, _ := NewManagedClient(server.URL+"/proxy", "")
	pages, err := client.PaginateAll(context.Background(), RawAPIRequest{Method: "GET", Path: "/v1.0/resources"}, PaginationOptions{PageLimit: 3, PageDelay: 1})
	if err != nil || len(pages) != 2 || calls.Load() != 2 {
		t.Fatalf("pages=%v calls=%d err=%v", pages, calls.Load(), err)
	}
}
