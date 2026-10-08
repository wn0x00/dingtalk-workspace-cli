package app

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/DingTalk-Real-AI/dingtalk-workspace-cli/internal/testseam"
	"github.com/DingTalk-Real-AI/dingtalk-workspace-cli/pkg/edition"
)

func TestCrossPlatformCoverageManagedAPIBypassesLocalCredentials(t *testing.T) {
	for _, status := range []int{200, 401} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/dingtalk/openapi/api/v1.0/microApp/allApps" || r.Header.Get("x-acs-dingtalk-access-token") != "" {
					t.Errorf("unexpected managed request")
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				if status == 200 {
					_, _ = io.WriteString(w, `{"appList":[]}`)
				} else {
					_, _ = io.WriteString(w, `{"code":"InvalidAuthentication","message":"rejected"}`)
				}
			}))
			defer server.Close()
			previous := edition.Get()
			t.Cleanup(func() { edition.Override(previous) })
			edition.Override(&edition.Hooks{ManagedOpenAPIBaseURL: server.URL + "/dingtalk"})
			t.Setenv("DWS_CLIENT_ID", "must-not-read")
			t.Setenv("DWS_CLIENT_SECRET", "must-not-read")
			testseam.Swap(t, &resolveRawAPICredentials, func(string, string, string) (rawAPICredentials, error) {
				t.Fatal("managed request read local credentials")
				return rawAPICredentials{}, nil
			})
			testseam.Swap(t, &newAppTokenProvider, func(string, string, string) appTokenGetter {
				t.Fatal("managed request requested local App Token")
				return nil
			})
			flags := &GlobalFlags{Format: "json"}
			cmd := newAPICommand(flags)
			var out bytes.Buffer
			cmd.SetOut(&out)
			cmd.SetErr(io.Discard)
			cmd.SetArgs([]string{"GET", "/v1.0/microApp/allApps"})
			err := cmd.Execute()
			if status == 200 && (err != nil || !strings.Contains(out.String(), "appList")) {
				t.Fatalf("output=%s err=%v", out.String(), err)
			}
			if status == 401 && err == nil {
				t.Fatal("401 returned success")
			}
			if calls.Load() != 1 {
				t.Fatalf("calls = %d", calls.Load())
			}
		})
	}
}

func TestCrossPlatformCoverageManagedAPIDryRunAndCredentials(t *testing.T) {
	previous := edition.Get()
	t.Cleanup(func() { edition.Override(previous) })
	edition.Override(&edition.Hooks{ManagedOpenAPIBaseURL: "http://127.0.0.1:1/proxy"})
	for _, tc := range []struct {
		name  string
		flags GlobalFlags
		args  []string
		fail  bool
	}{
		{"dry-run", GlobalFlags{DryRun: true}, []string{"GET", "/v1.0/microApp/allApps"}, false},
		{"dry-run-token-query", GlobalFlags{DryRun: true}, []string{"GET", "/v1.0/microApp/allApps", "--params", `{"access_token":"must-not-leak"}`}, true},
		{"token-endpoint", GlobalFlags{DryRun: true}, []string{"POST", "/v1.0/oauth2/accessToken"}, true},
		{"local-token", GlobalFlags{Token: "must-not-leak"}, []string{"GET", "/v1.0/microApp/allApps"}, true},
		{"local-app", GlobalFlags{ClientID: "id", ClientSecret: "must-not-leak"}, []string{"GET", "/v1.0/microApp/allApps"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cmd := newAPICommand(&tc.flags)
			var out bytes.Buffer
			cmd.SetOut(&out)
			cmd.SetErr(io.Discard)
			cmd.SetArgs(tc.args)
			err := cmd.Execute()
			if (err != nil) != tc.fail {
				t.Fatalf("error = %v", err)
			}
			if strings.Contains(out.String(), "must-not-leak") || (err != nil && strings.Contains(err.Error(), "must-not-leak")) {
				t.Fatal("credential leaked")
			}
		})
	}
}
