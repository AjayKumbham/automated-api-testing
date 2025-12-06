import { useState } from "react";

function App() {
  const [endpoint, setEndpoint] = useState("/users");
  const [method, setMethod] = useState("POST");
  const [targetUrl, setTargetUrl] = useState("http://localhost:3000");
  const [headers, setHeaders] = useState('{"Content-Type": "application/json"}');
  const [body, setBody] = useState('{"name": "John Doe", "email": "john@example.com"}');
  const [expectedStatus, setExpectedStatus] = useState("201");

  const [testCases, setTestCases] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState(null);

  const handleMethodChange = (newMethod) => {
    setMethod(newMethod);
    if (newMethod === "GET") {
      setExpectedStatus("200");
    } else if (newMethod === "POST") {
      setExpectedStatus("201");
    } else if (newMethod === "DELETE") {
      setExpectedStatus("204");
    } else {
      setExpectedStatus("200");
    }
  };

  const generateTests = async () => {
    setLoading(true);
    setError("");
    
    try {
      let parsedHeaders = {};
      let parsedBody = {};
      
      try {
        parsedHeaders = headers ? JSON.parse(headers) : {};
      } catch (e) {
        throw new Error("Invalid JSON in headers. Please check syntax.");
      }
      
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        try {
          parsedBody = body ? JSON.parse(body) : {};
        } catch (e) {
          throw new Error("Invalid JSON in body. Please check syntax.");
        }
      }

      const spec = {
        endpoint,
        method,
        headers: parsedHeaders,
        body: parsedBody,
        expected_response: {
          status: parseInt(expectedStatus)
        }
      };

      const res = await fetch("http://localhost:3000/generate-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec })
      });
      
      const data = await res.json();
      
      if (data.success) {
        setTestCases(data.testCases);
        setSummary(data.summary);
        setResults([]);
        setError("");
      } else {
        setError(data.error || "Failed to generate tests");
      }
    } catch (err) {
      console.error(err);
      setError(err.message || "Failed to generate tests. Check console for details.");
    } finally {
      setLoading(false);
    }
  };

  const runTests = async () => {
    setLoading(true);
    setError("");
    
    try {
      const res = await fetch("http://localhost:3000/run-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          testCases,
          targetUrl: targetUrl || "http://localhost:3000"
        })
      });
      
      const data = await res.json();
      
      if (data.success) {
        setResults(data.results);
        setSummary(data.summary);
        setError("");
      } else {
        setError(data.error || "Failed to run tests");
      }
    } catch (err) {
      console.error(err);
      setError(err.message || "Failed to run tests. Is the server running?");
    } finally {
      setLoading(false);
    }
  };

  const handleClearAll = () => {
    setTestCases([]);
    setResults([]);
    setError("");
    setSummary(null);
  };

  const exportResults = () => {
    const exportData = {
      specification: {
        endpoint,
        method,
        targetUrl,
        timestamp: new Date().toISOString()
      },
      summary,
      testCases: results
    };
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `test-results-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getCategoryIcon = (category) => {
    switch(category) {
      case 'valid': return '✅';
      case 'invalid': return '❌';
      case 'boundary': return '⚠️';
      case 'security': return '🔒';
      default: return '📝';
    }
  };

  const getCategoryColor = (category) => {
    switch(category) {
      case 'valid': return '#10b981';
      case 'invalid': return '#ef4444';
      case 'boundary': return '#f59e0b';
      case 'security': return '#8b5cf6';
      default: return '#6b7280';
    }
  };

  return (
    <div style={{ padding: "30px", fontFamily: "system-ui, sans-serif", background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)", minHeight: "100vh" }}>
      <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
        <h1 style={{ 
          textAlign: "center", 
          color: "#fff", 
          fontSize: "42px", 
          marginBottom: "10px",
          textShadow: "2px 2px 4px rgba(0,0,0,0.3)"
        }}>
          🚀 AI API Test Generator v2.0
        </h1>
        <p style={{ textAlign: "center", color: "#e0e7ff", marginBottom: "30px", fontSize: "16px" }}>
          Generate comprehensive, accurate test cases with enhanced validation & security
        </p>

        {error && (
          <div style={{
            margin: "0 auto 20px",
            maxWidth: "1000px",
            padding: "16px 20px",
            background: "#fef2f2",
            border: "2px solid #ef4444",
            borderRadius: "12px",
            color: "#991b1b",
            display: "flex",
            alignItems: "center",
            gap: "12px"
          }}>
            <span style={{ fontSize: "24px" }}>⚠️</span>
            <div>
              <strong style={{ display: "block", marginBottom: "4px" }}>Error</strong>
              {error}
            </div>
          </div>
        )}

        <div style={{
          margin: "20px auto",
          maxWidth: "1000px",
          background: "#fff",
          padding: "30px",
          borderRadius: "16px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.15)"
        }}>
          <h3 style={{ marginTop: 0, color: "#1f2937", fontSize: "20px", marginBottom: "20px" }}>
            📋 API Specification
          </h3>

          <div style={{ marginBottom: "20px" }}>
            <label style={{ display: "block", marginBottom: "8px", fontWeight: "600", color: "#374151", fontSize: "14px" }}>
              🌐 Target URL (Base URL)
            </label>
            <input
              type="text"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="http://localhost:3000 or https://api.example.com"
              style={{
                width: "100%",
                padding: "12px 16px",
                border: "2px solid #e5e7eb",
                borderRadius: "8px",
                fontSize: "14px",
                fontFamily: "monospace",
                transition: "border-color 0.2s"
              }}
              onFocus={(e) => e.target.style.borderColor = "#667eea"}
              onBlur={(e) => e.target.style.borderColor = "#e5e7eb"}
            />
            <small style={{ color: "#6b7280", fontSize: "12px", marginTop: "4px", display: "block" }}>
              The base URL where your API is hosted
            </small>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "20px", marginBottom: "20px" }}>
            <div>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "600", color: "#374151", fontSize: "14px" }}>
                🔗 Endpoint Path
              </label>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="/api/users"
                style={{
                  width: "100%",
                  padding: "12px 16px",
                  border: "2px solid #e5e7eb",
                  borderRadius: "8px",
                  fontSize: "14px",
                  fontFamily: "monospace",
                  transition: "border-color 0.2s"
                }}
                onFocus={(e) => e.target.style.borderColor = "#667eea"}
                onBlur={(e) => e.target.style.borderColor = "#e5e7eb"}
              />
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "600", color: "#374151", fontSize: "14px" }}>
                📡 Method
              </label>
              <select
                value={method}
                onChange={(e) => handleMethodChange(e.target.value)}
                style={{
                  width: "100%",
                  padding: "12px 16px",
                  border: "2px solid #e5e7eb",
                  borderRadius: "8px",
                  fontSize: "14px",
                  fontWeight: "600",
                  background: "#fff",
                  cursor: "pointer"
                }}
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
              </select>
            </div>
          </div>

          <div style={{ marginBottom: "20px" }}>
            <label style={{ display: "block", marginBottom: "8px", fontWeight: "600", color: "#374151", fontSize: "14px" }}>
              📄 Headers (JSON)
            </label>
            <textarea
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder='{"Content-Type": "application/json", "Authorization": "Bearer token"}'
              style={{
                width: "100%",
                height: "70px",
                padding: "12px 16px",
                fontFamily: "monospace",
                border: "2px solid #e5e7eb",
                borderRadius: "8px",
                fontSize: "13px",
                resize: "vertical"
              }}
            />
          </div>

          {['POST', 'PUT', 'PATCH'].includes(method) && (
            <div style={{ marginBottom: "20px" }}>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "600", color: "#374151", fontSize: "14px" }}>
                📦 Request Body (JSON)
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder='{"key": "value"}'
                style={{
                  width: "100%",
                  height: "100px",
                  padding: "12px 16px",
                  fontFamily: "monospace",
                  border: "2px solid #e5e7eb",
                  borderRadius: "8px",
                  fontSize: "13px",
                  resize: "vertical"
                }}
              />
            </div>
          )}

          <div style={{ marginBottom: "24px" }}>
            <label style={{ display: "block", marginBottom: "8px", fontWeight: "600", color: "#374151", fontSize: "14px" }}>
              ✓ Expected Success Status Code
            </label>
            <input
              type="text"
              value={expectedStatus}
              onChange={(e) => setExpectedStatus(e.target.value)}
              placeholder="200"
              style={{
                width: "150px",
                padding: "12px 16px",
                border: "2px solid #e5e7eb",
                borderRadius: "8px",
                fontSize: "14px",
                fontFamily: "monospace"
              }}
            />
          </div>

          <button
            onClick={generateTests}
            disabled={loading}
            style={{
              padding: "14px 32px",
              background: loading ? "#9ca3af" : "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
              color: "white",
              border: "none",
              borderRadius: "10px",
              cursor: loading ? "not-allowed" : "pointer",
              fontSize: "16px",
              fontWeight: "700",
              transition: "transform 0.2s, box-shadow 0.2s",
              boxShadow: "0 4px 12px rgba(102, 126, 234, 0.4)"
            }}
            onMouseEnter={(e) => {
              if (!loading) {
                e.target.style.transform = "translateY(-2px)";
                e.target.style.boxShadow = "0 6px 20px rgba(102, 126, 234, 0.6)";
              }
            }}
            onMouseLeave={(e) => {
              e.target.style.transform = "translateY(0)";
              e.target.style.boxShadow = "0 4px 12px rgba(102, 126, 234, 0.4)";
            }}
          >
            {loading ? "⏳ Generating..." : "🚀 Generate Test Cases"}
          </button>
        </div>

        {summary && testCases.length > 0 && (
          <div style={{
            margin: "20px auto",
            maxWidth: "1000px",
            background: "#fff",
            padding: "20px",
            borderRadius: "16px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.15)"
          }}>
            <div style={{ 
              display: "grid", 
              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", 
              gap: "12px",
              marginBottom: "20px"
            }}>
              <div style={{ padding: "16px", background: "#f0f9ff", borderRadius: "10px", textAlign: "center" }}>
                <div style={{ fontSize: "28px", fontWeight: "bold", color: "#0284c7" }}>{summary.total}</div>
                <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>Total</div>
              </div>
              <div style={{ padding: "16px", background: "#f0fdf4", borderRadius: "10px", textAlign: "center" }}>
                <div style={{ fontSize: "28px", fontWeight: "bold", color: "#10b981" }}>{summary.valid}</div>
                <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>✅ Valid</div>
              </div>
              <div style={{ padding: "16px", background: "#fef2f2", borderRadius: "10px", textAlign: "center" }}>
                <div style={{ fontSize: "28px", fontWeight: "bold", color: "#ef4444" }}>{summary.invalid}</div>
                <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>❌ Invalid</div>
              </div>
              <div style={{ padding: "16px", background: "#fffbeb", borderRadius: "10px", textAlign: "center" }}>
                <div style={{ fontSize: "28px", fontWeight: "bold", color: "#f59e0b" }}>{summary.boundary}</div>
                <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>⚠️ Boundary</div>
              </div>
              <div style={{ padding: "16px", background: "#faf5ff", borderRadius: "10px", textAlign: "center" }}>
                <div style={{ fontSize: "28px", fontWeight: "bold", color: "#8b5cf6" }}>{summary.security}</div>
                <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>🔒 Security</div>
              </div>
            </div>
          </div>
        )}

        {testCases.length > 0 && (
          <div style={{ margin: "20px auto", maxWidth: "1000px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "15px" }}>
              <h3 style={{ margin: 0, color: "#fff", fontSize: "24px" }}>
                📝 Generated Test Cases ({testCases.length})
              </h3>
              <button
                onClick={handleClearAll}
                style={{
                  padding: "10px 20px",
                  background: "#ef4444",
                  color: "white",
                  border: "none",
                  borderRadius: "8px",
                  cursor: "pointer",
                  fontSize: "14px",
                  fontWeight: "600"
                }}
              >
                🗑️ Clear All
              </button>
            </div>

            <div style={{
              background: "#fff",
              borderRadius: "16px",
              overflow: "hidden",
              boxShadow: "0 8px 32px rgba(0,0,0,0.15)"
            }}>
              {testCases.map((t, i) => (
                <div
                  key={t.id}
                  style={{
                    padding: "16px 20px",
                    borderBottom: i < testCases.length - 1 ? "1px solid #e5e7eb" : "none",
                    display: "flex",
                    alignItems: "center",
                    gap: "16px"
                  }}
                >
                  <div style={{
                    fontSize: "24px",
                    minWidth: "32px",
                    textAlign: "center"
                  }}>
                    {getCategoryIcon(t.category)}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "4px" }}>
                      <span style={{ 
                        fontWeight: "700", 
                        color: "#1f2937",
                        fontSize: "14px"
                      }}>
                        {t.id}
                      </span>
                      <span style={{
                        padding: "2px 8px",
                        background: getCategoryColor(t.category) + "20",
                        color: getCategoryColor(t.category),
                        borderRadius: "4px",
                        fontSize: "11px",
                        fontWeight: "600",
                        textTransform: "uppercase"
                      }}>
                        {t.category}
                      </span>
                    </div>
                    <div style={{ color: "#6b7280", fontSize: "14px" }}>
                      {t.description}
                    </div>
                  </div>
                  <div style={{
                    padding: "6px 12px",
                    background: "#f3f4f6",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: "700",
                    color: "#374151"
                  }}>
                    {t.expected_response.status}
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={runTests}
              disabled={loading}
              style={{
                marginTop: "15px",
                padding: "14px 32px",
                background: loading ? "#9ca3af" : "#10b981",
                color: "white",
                border: "none",
                borderRadius: "10px",
                cursor: loading ? "not-allowed" : "pointer",
                fontSize: "16px",
                fontWeight: "700",
                boxShadow: "0 4px 12px rgba(16, 185, 129, 0.4)"
              }}
            >
              {loading ? "⏳ Running..." : "▶️ Run All Tests"}
            </button>
          </div>
        )}

        {results.length > 0 && (
          <div style={{
            margin: "20px auto",
            maxWidth: "1000px",
            background: "#fff",
            padding: "30px",
            borderRadius: "16px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.15)"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
              <h3 style={{ margin: 0, color: "#1f2937", fontSize: "24px" }}>
                📊 Test Results
              </h3>
              <button
                onClick={exportResults}
                style={{
                  padding: "10px 20px",
                  background: "#3b82f6",
                  color: "white",
                  border: "none",
                  borderRadius: "8px",
                  cursor: "pointer",
                  fontSize: "14px",
                  fontWeight: "600"
                }}
              >
                💾 Export JSON
              </button>
            </div>

            {summary && (
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: "12px",
                marginBottom: "25px"
              }}>
                <div style={{ padding: "16px", background: "#f0f9ff", borderRadius: "10px", textAlign: "center" }}>
                  <div style={{ fontSize: "28px", fontWeight: "bold", color: "#0284c7" }}>{summary.total}</div>
                  <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>Total Tests</div>
                </div>
                <div style={{ padding: "16px", background: "#f0fdf4", borderRadius: "10px", textAlign: "center" }}>
                  <div style={{ fontSize: "28px", fontWeight: "bold", color: "#10b981" }}>{summary.passed}</div>
                  <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>✅ Passed</div>
                </div>
                <div style={{ padding: "16px", background: "#fef2f2", borderRadius: "10px", textAlign: "center" }}>
                  <div style={{ fontSize: "28px", fontWeight: "bold", color: "#ef4444" }}>{summary.failed}</div>
                  <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>❌ Failed</div>
                </div>
                <div style={{ padding: "16px", background: "#fefce8", borderRadius: "10px", textAlign: "center" }}>
                  <div style={{ fontSize: "28px", fontWeight: "bold", color: "#eab308" }}>{summary.errors}</div>
                  <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>⚠️ Errors</div>
                </div>
                <div style={{ padding: "16px", background: "#f5f3ff", borderRadius: "10px", textAlign: "center" }}>
                  <div style={{ fontSize: "28px", fontWeight: "bold", color: "#8b5cf6" }}>{summary.passRate}</div>
                  <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>Pass Rate</div>
                </div>
                <div style={{ padding: "16px", background: "#f8fafc", borderRadius: "10px", textAlign: "center" }}>
                  <div style={{ fontSize: "28px", fontWeight: "bold", color: "#64748b" }}>{summary.duration}</div>
                  <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>⏱️ Duration</div>
                </div>
              </div>
            )}

            <div style={{ marginBottom: "20px" }}>
              {results.map((r) => (
                <div
                  key={r.id}
                  style={{
                    padding: "20px",
                    marginBottom: "12px",
                    background: r.status.includes("PASSED") 
                      ? "linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)" 
                      : r.status.includes("ERROR")
                      ? "linear-gradient(135deg, #fefce8 0%, #fef3c7 100%)"
                      : "linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%)",
                    border: `2px solid ${
                      r.status.includes("PASSED") 
                        ? "#10b981" 
                        : r.status.includes("ERROR")
                        ? "#eab308"
                        : "#ef4444"
                    }`,
                    borderRadius: "12px",
                    transition: "transform 0.2s, box-shadow 0.2s"
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = "translateY(-2px)";
                    e.currentTarget.style.boxShadow = "0 8px 24px rgba(0,0,0,0.12)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = "translateY(0)";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
                        <span style={{ fontSize: "20px" }}>
                          {getCategoryIcon(r.category)}
                        </span>
                        <strong style={{ color: "#1f2937", fontSize: "16px" }}>{r.id}</strong>
                        <span style={{
                          padding: "2px 8px",
                          background: getCategoryColor(r.category) + "30",
                          color: getCategoryColor(r.category),
                          borderRadius: "4px",
                          fontSize: "11px",
                          fontWeight: "600",
                          textTransform: "uppercase"
                        }}>
                          {r.category}
                        </span>
                      </div>
                      <div style={{ color: "#4b5563", fontSize: "14px", marginBottom: "8px" }}>
                        {r.description}
                      </div>
                      {r.url && (
                        <div style={{ 
                          fontSize: "12px", 
                          color: "#6b7280",
                          fontFamily: "monospace",
                          background: "#fff",
                          padding: "6px 10px",
                          borderRadius: "6px",
                          marginTop: "8px"
                        }}>
                          <strong>URL:</strong> {r.url}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px" }}>
                      <span
                        style={{
                          fontWeight: "bold",
                          fontSize: "18px",
                          color: r.status.includes("PASSED") 
                            ? "#10b981" 
                            : r.status.includes("ERROR")
                            ? "#eab308"
                            : "#ef4444"
                        }}
                      >
                        {r.status}
                      </span>
                      <span style={{
                        fontSize: "12px",
                        color: "#6b7280",
                        background: "#fff",
                        padding: "4px 10px",
                        borderRadius: "6px"
                      }}>
                        {r.duration}
                      </span>
                    </div>
                  </div>

                  {r.validations && (
                    <div style={{
                      marginTop: "12px",
                      padding: "12px",
                      background: "#fff",
                      borderRadius: "8px",
                      fontSize: "13px"
                    }}>
                      <strong style={{ color: "#374151", display: "block", marginBottom: "8px" }}>
                        Validation Details:
                      </strong>
                      {r.validations.details.map((v, idx) => (
                        <div key={idx} style={{
                          display: "flex",
                          justifyContent: "space-between",
                          padding: "6px 0",
                          borderBottom: idx < r.validations.details.length - 1 ? "1px solid #f3f4f6" : "none"
                        }}>
                          <span style={{ color: "#6b7280" }}>
                            {v.check.replace(/_/g, ' ').toUpperCase()}:
                          </span>
                          <span style={{
                            fontWeight: "600",
                            color: v.passed ? "#10b981" : "#ef4444"
                          }}>
                            {v.passed ? "✓" : "✗"} {v.actual}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {r.error && (
                    <div style={{
                      marginTop: "12px",
                      padding: "12px",
                      background: "#fff",
                      borderRadius: "8px",
                      fontSize: "13px",
                      color: "#dc2626",
                      border: "1px solid #fca5a5"
                    }}>
                      <strong>Error:</strong> {r.error}
                    </div>
                  )}

                  {r.actual && r.actual.status && (
                    <div style={{
                      marginTop: "12px",
                      padding: "12px",
                      background: "#fff",
                      borderRadius: "8px",
                      fontSize: "13px"
                    }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                        <div>
                          <strong style={{ color: "#374151", display: "block", marginBottom: "4px" }}>
                            Expected Status:
                          </strong>
                          <span style={{
                            padding: "4px 10px",
                            background: "#f3f4f6",
                            borderRadius: "6px",
                            fontFamily: "monospace",
                            fontWeight: "600",
                            color: "#1f2937"
                          }}>
                            {r.expected.status}
                          </span>
                        </div>
                        <div>
                          <strong style={{ color: "#374151", display: "block", marginBottom: "4px" }}>
                            Actual Status:
                          </strong>
                          <span style={{
                            padding: "4px 10px",
                            background: r.actual.status === r.expected.status ? "#d1fae5" : "#fee2e2",
                            color: r.actual.status === r.expected.status ? "#065f46" : "#991b1b",
                            borderRadius: "6px",
                            fontFamily: "monospace",
                            fontWeight: "600"
                          }}>
                            {r.actual.status} {r.actual.statusText}
                          </span>
                        </div>
                      </div>
                      
                      {r.actual.data && (
                        <details style={{ marginTop: "12px" }}>
                          <summary style={{
                            cursor: "pointer",
                            fontWeight: "600",
                            color: "#374151",
                            padding: "8px",
                            background: "#f9fafb",
                            borderRadius: "6px"
                          }}>
                            📄 Response Body
                          </summary>
                          <pre style={{
                            marginTop: "8px",
                            padding: "12px",
                            background: "#1f2937",
                            color: "#e5e7eb",
                            borderRadius: "6px",
                            overflow: "auto",
                            fontSize: "12px",
                            maxHeight: "200px"
                          }}>
                            {JSON.stringify(r.actual.data, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div style={{
              padding: "20px",
              background: "linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)",
              borderRadius: "12px",
              border: "2px solid #0284c7"
            }}>
              <h4 style={{ margin: "0 0 12px 0", color: "#0c4a6e", fontSize: "16px" }}>
                📈 Summary
              </h4>
              <div style={{ fontSize: "14px", color: "#0c4a6e", lineHeight: "1.8" }}>
                <div>✓ Tested against: <strong>{summary.testedAgainst}</strong></div>
                <div>✓ Total duration: <strong>{summary.duration}</strong></div>
                <div>✓ Average per test: <strong>{summary.avgDuration}</strong></div>
                <div>✓ Success rate: <strong style={{ 
                  color: parseFloat(summary.passRate) >= 70 ? "#10b981" : "#ef4444",
                  fontSize: "16px"
                }}>
                  {summary.passRate}
                </strong></div>
              </div>
            </div>
          </div>
        )}

        <div style={{
          maxWidth: "1000px",
          margin: "30px auto",
          padding: "20px",
          background: "rgba(255, 255, 255, 0.1)",
          borderRadius: "12px",
          backdropFilter: "blur(10px)"
        }}>
          <h4 style={{ color: "#fff", fontSize: "18px", marginBottom: "12px" }}>
            ✨ Enhanced Features v2.0
          </h4>
          <div style={{ 
            display: "grid", 
            gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
            gap: "12px",
            fontSize: "13px",
            color: "#e0e7ff"
          }}>
            <div>✓ RFC-compliant email validation</div>
            <div>✓ 13 XSS detection patterns</div>
            <div>✓ 16 SQL injection patterns</div>
            <div>✓ Path traversal protection</div>
            <div>✓ Structured JSON from AI</div>
            <div>✓ Intelligent retry logic</div>
            <div>✓ Parallel test execution</div>
            <div>✓ Detailed validation reports</div>
            <div>✓ Export results to JSON</div>
            <div>✓ Category-based organization</div>
            <div>✓ Enhanced error messages</div>
            <div>✓ Performance metrics</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;