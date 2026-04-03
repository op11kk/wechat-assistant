import Foundation

// MARK: - 网关配置

/// 联调默认本机；真机/模拟器访问电脑请改为 `http://<你的局域网IP>:5000`，上线改为 HTTPS 网关。
public enum APIConfig {
    public static var baseURL: URL = URL(string: "http://127.0.0.1:5000")!
}

// MARK: - 时间序列化（与 Flask 对齐：ISO8601 或 Unix 秒/毫秒）

/// JSON 中单值：ISO8601 字符串，或 Unix 纪元秒（Double，>= 1e9 量级；更大按毫秒折算由服务端处理）。
/// CACurrentMediaTime 为“开机后秒数”，不是墙钟；请用 `Date().timeIntervalSince1970` 上传绝对时间，
/// 或在请求里设 `timestamp_is_elapsed: true` 并传「相对录制起点」的秒数（与服务端 session.start_time 墙钟对齐时等价于墙钟流逝）。
public enum TimestampField: Codable, Sendable {
    case iso8601(String)
    case unixSeconds(Double)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) {
            self = .iso8601(s)
            return
        }
        if let n = try? c.decode(Double.self) {
            self = .unixSeconds(n)
            return
        }
        if let i = try? c.decode(Int.self) {
            self = .unixSeconds(Double(i))
            return
        }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "timestamp: expected String or Number")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .iso8601(let s): try c.encode(s)
        case .unixSeconds(let n): try c.encode(n)
        }
    }
}

public typealias WireTimestamptz = TimestampField

// MARK: - Models（decoder 使用 convertFromSnakeCase；timestamp 等自定义字段见上）

public struct HealthResponse: Codable, Sendable {
    public let status: String
}

public struct ErrorResponse: Codable, Sendable {
    public let error: String
    public let detail: String?
    public let hint: String?
}

public struct SensorSample: Codable, Sendable {
    public let id: Int64
    public let sessionId: String
    public let sensorType: String
    public let x: Double?
    public let y: Double?
    public let z: Double?
    public let timestamp: String
    public let createdAt: String?
}

public struct SensorSampleInput: Codable, Sendable {
    public let sessionId: String
    public let sensorType: String
    public let x: Double
    public let y: Double
    public let z: Double
    public let timestamp: TimestampField
    /// 为 true 时，`timestamp` 须为数字，表示相对 `sessions.start_time` 墙钟的秒数（如 CACurrentMediaTime - 录制起点 MediaTime）。
    public var timestampIsElapsed: Bool?

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case sensorType = "sensor_type"
        case x, y, z, timestamp
        case timestampIsElapsed = "timestamp_is_elapsed"
    }

    public init(
        sessionId: String,
        sensorType: String,
        x: Double,
        y: Double,
        z: Double,
        timestamp: TimestampField,
        timestampIsElapsed: Bool? = nil
    ) {
        self.sessionId = sessionId
        self.sensorType = sensorType
        self.x = x
        self.y = y
        self.z = z
        self.timestamp = timestamp
        self.timestampIsElapsed = timestampIsElapsed
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        sensorType = try c.decode(String.self, forKey: .sensorType)
        x = try c.decode(Double.self, forKey: .x)
        y = try c.decode(Double.self, forKey: .y)
        z = try c.decode(Double.self, forKey: .z)
        let tdec = try c.superDecoder(forKey: .timestamp)
        timestamp = try TimestampField(from: tdec)
        timestampIsElapsed = try c.decodeIfPresent(Bool.self, forKey: .timestampIsElapsed)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sessionId, forKey: .sessionId)
        try c.encode(sensorType, forKey: .sensorType)
        try c.encode(x, forKey: .x)
        try c.encode(y, forKey: .y)
        try c.encode(z, forKey: .z)
        var sc = c.superEncoder(forKey: .timestamp)
        try timestamp.encode(to: sc)
        try c.encodeIfPresent(timestampIsElapsed, forKey: .timestampIsElapsed)
    }
}

public struct UploadSensorResponse: Codable, Sendable {
    public let message: String
    public let id: Int64
}

public struct BatchUploadBody: Codable, Sendable {
    public var items: [SensorSampleInput]
    public var timestampIsElapsed: Bool?

    enum CodingKeys: String, CodingKey {
        case items
        case timestampIsElapsed = "timestamp_is_elapsed"
    }

    public init(items: [SensorSampleInput], timestampIsElapsed: Bool? = nil) {
        self.items = items
        self.timestampIsElapsed = timestampIsElapsed
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decode([SensorSampleInput].self, forKey: .items)
        timestampIsElapsed = try c.decodeIfPresent(Bool.self, forKey: .timestampIsElapsed)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(items, forKey: .items)
        try c.encodeIfPresent(timestampIsElapsed, forKey: .timestampIsElapsed)
    }
}

public struct BatchUploadResponse: Codable, Sendable {
    public let message: String
    public let count: Int
    public let ids: [Int64]
}

/// 视图 session_stats：sessions.* + 聚合字段
public struct SessionStats: Codable, Sendable {
    public let id: Int64
    public let sessionId: String
    public let userSelectedMode: String
    public let captureMode: String
    public let deviceModel: String?
    public let iosVersion: String?
    public let appVersion: String?
    public let startTime: String
    public let endTime: String?
    public let durationMs: Int?
    public let totalRgbFrames: Int?
    public let totalPoseSamples: Int?
    public let totalImuSamples: Int?
    public let totalDepthFrames: Int?
    public let uploadStatus: String?
    public let createdAt: String?
    public let sampleCount: Int64
    public let firstTimestamp: String?
    public let lastTimestamp: String?
}

public struct SessionRow: Codable, Sendable {
    public let id: Int64
    public let sessionId: String
    public let userSelectedMode: String
    public let captureMode: String
    public let deviceModel: String?
    public let iosVersion: String?
    public let appVersion: String?
    public let startTime: String
    public let endTime: String?
    public let durationMs: Int?
    public let totalRgbFrames: Int?
    public let totalPoseSamples: Int?
    public let totalImuSamples: Int?
    public let totalDepthFrames: Int?
    public let uploadStatus: String?
    public let createdAt: String?
}

public struct CreateSessionRequest: Codable, Sendable {
    public let sessionId: String
    public let userSelectedMode: String
    public let captureMode: String
    public let startTime: WireTimestamptz
    public var deviceModel: String?
    public var iosVersion: String?
    public var appVersion: String?
    public var endTime: WireTimestamptz?
    public var durationMs: Int?
    public var totalRgbFrames: Int?
    public var totalPoseSamples: Int?
    public var totalImuSamples: Int?
    public var totalDepthFrames: Int?
    public var uploadStatus: String?

    public init(
        sessionId: String,
        userSelectedMode: String,
        captureMode: String,
        startTime: WireTimestamptz
    ) {
        self.sessionId = sessionId
        self.userSelectedMode = userSelectedMode
        self.captureMode = captureMode
        self.startTime = startTime
    }

    /// 使用 ISO8601 墙钟字符串（与原先行为一致）
    public init(
        sessionId: String,
        userSelectedMode: String,
        captureMode: String,
        startTimeISO8601: String
    ) {
        self.init(
            sessionId: sessionId,
            userSelectedMode: userSelectedMode,
            captureMode: captureMode,
            startTime: .iso8601(startTimeISO8601)
        )
    }

    /// 使用 Unix 秒（如 `Date().timeIntervalSince1970`）
    public init(
        sessionId: String,
        userSelectedMode: String,
        captureMode: String,
        startTimeUnixSeconds: Double
    ) {
        self.init(
            sessionId: sessionId,
            userSelectedMode: userSelectedMode,
            captureMode: captureMode,
            startTime: .unixSeconds(startTimeUnixSeconds)
        )
    }
}

public struct CreateSessionResponse: Codable, Sendable {
    public let message: String
    public let session: SessionRow
}

/// PATCH /sessions/{session_id}，仅编码非 nil 字段
public struct PatchSessionRequest: Codable, Sendable {
    public var userSelectedMode: String?
    public var captureMode: String?
    public var deviceModel: String?
    public var iosVersion: String?
    public var appVersion: String?
    public var startTime: WireTimestamptz?
    public var endTime: WireTimestamptz?
    public var durationMs: Int?
    public var totalRgbFrames: Int?
    public var totalPoseSamples: Int?
    public var totalImuSamples: Int?
    public var totalDepthFrames: Int?
    public var uploadStatus: String?

    public init() {}
}

public struct UpdateSessionResponse: Codable, Sendable {
    public let message: String
    public let session: SessionRow
}

public struct SessionsListResponse: Codable, Sendable {
    public let sessions: [SessionStats]
}

public struct SessionSamplesResponse: Codable, Sendable {
    public let sessionId: String
    public let items: [SensorSample]
    public let count: Int
    public let nextCursor: Int64?
    public let hasMore: Bool
}

public struct DeleteSessionResponse: Codable, Sendable {
    public let message: String
    public let sessionId: String
}

// MARK: - Errors

public enum IOSBehindError: Error, Sendable {
    case badURL
    /// HTTP 非成功且无法解析为 JSON 错误体
    case invalidResponse(statusCode: Int, body: Data?)
    /// 服务端返回的 JSON 错误（401/4xx/5xx 等）
    case apiError(statusCode: Int, payload: ErrorResponse)
    case decodingFailed(Error)
    case transport(Error)
}

// MARK: - Client

/// 对应 Flask 后端；`apiSecret` 与服务端 `API_SECRET` 一致。
/// 默认使用 `Authorization: Bearer`；将 `preferAPIKeyHeader = true` 时改为 `X-API-Key`。
public final class IOSBehindClient: @unchecked Sendable {
    public let baseURL: URL
    public var apiSecret: String?
    public var preferAPIKeyHeader: Bool = false

    public init(baseURL: URL, apiSecret: String? = nil, preferAPIKeyHeader: Bool = false) {
        self.baseURL = baseURL
        self.apiSecret = apiSecret
        self.preferAPIKeyHeader = preferAPIKeyHeader
    }

    /// 使用 `APIConfig.baseURL`（默认本机，真机前请改 `APIConfig.baseURL`）
    public convenience init(apiSecret: String? = nil, preferAPIKeyHeader: Bool = false) {
        self.init(baseURL: APIConfig.baseURL, apiSecret: apiSecret, preferAPIKeyHeader: preferAPIKeyHeader)
    }

    private let urlSession: URLSession = .shared

    private var jsonDecoder: JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    private var jsonEncoder: JSONEncoder {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }

    private func authorizedRequest(url: URL, method: String, body: Data? = nil) -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let s = apiSecret, !s.isEmpty {
            if preferAPIKeyHeader {
                req.setValue(s, forHTTPHeaderField: "X-API-Key")
            } else {
                req.setValue("Bearer \(s)", forHTTPHeaderField: "Authorization")
            }
        }
        req.httpBody = body
        return req
    }

    private func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await urlSession.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw IOSBehindError.invalidResponse(statusCode: -1, body: data)
            }
            return (data, http)
        } catch let e as IOSBehindError {
            throw e
        } catch {
            throw IOSBehindError.transport(error)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data, status: Int) throws -> T {
        if (200...299).contains(status) {
            do {
                return try jsonDecoder.decode(T.self, from: data)
            } catch {
                throw IOSBehindError.decodingFailed(error)
            }
        }
        if let payload = try? jsonDecoder.decode(ErrorResponse.self, from: data) {
            throw IOSBehindError.apiError(statusCode: status, payload: payload)
        }
        throw IOSBehindError.invalidResponse(statusCode: status, body: data)
    }

    // MARK: API

    public func health() async throws -> HealthResponse {
        let url = baseURL.appendingPathComponent("health")
        let req = authorizedRequest(url: url, method: "GET")
        let (data, http) = try await data(for: req)
        return try decode(HealthResponse.self, from: data, status: http.statusCode)
    }

    public func uploadSensor(_ sample: SensorSampleInput) async throws -> UploadSensorResponse {
        let url = baseURL.appendingPathComponent("upload_sensor")
        let body = try jsonEncoder.encode(sample)
        let req = authorizedRequest(url: url, method: "POST", body: body)
        let (data, http) = try await data(for: req)
        return try decode(UploadSensorResponse.self, from: data, status: http.statusCode)
    }

    public func uploadSensorBatch(
        items: [SensorSampleInput],
        timestampIsElapsed: Bool? = nil
    ) async throws -> BatchUploadResponse {
        let url = baseURL.appendingPathComponent("upload_sensor_batch")
        let body = try jsonEncoder.encode(BatchUploadBody(items: items, timestampIsElapsed: timestampIsElapsed))
        let req = authorizedRequest(url: url, method: "POST", body: body)
        let (data, http) = try await data(for: req)
        return try decode(BatchUploadResponse.self, from: data, status: http.statusCode)
    }

    public func createSession(_ body: CreateSessionRequest) async throws -> CreateSessionResponse {
        let url = baseURL.appendingPathComponent("sessions")
        let encoded = try jsonEncoder.encode(body)
        let req = authorizedRequest(url: url, method: "POST", body: encoded)
        let (data, http) = try await data(for: req)
        return try decode(CreateSessionResponse.self, from: data, status: http.statusCode)
    }

    public func listSessions() async throws -> SessionsListResponse {
        let url = baseURL.appendingPathComponent("sessions")
        let req = authorizedRequest(url: url, method: "GET")
        let (data, http) = try await data(for: req)
        return try decode(SessionsListResponse.self, from: data, status: http.statusCode)
    }

    public func listSessionSamples(
        sessionId: String,
        limit: Int? = nil,
        afterId: Int64? = nil,
        since: String? = nil
    ) async throws -> SessionSamplesResponse {
        guard var comp = URLComponents(url: baseURL, resolvingAgainstBaseURL: true) else {
            throw IOSBehindError.badURL
        }
        var path = comp.path
        if path.hasSuffix("/") {
            path.removeLast()
        }
        let encodedSession = sessionId.pathSegmentPercentEncoded
        comp.path = "\(path)/sessions/\(encodedSession)/samples"
        var q: [URLQueryItem] = []
        if let limit {
            q.append(URLQueryItem(name: "limit", value: String(limit)))
        }
        if let afterId {
            q.append(URLQueryItem(name: "after_id", value: String(afterId)))
        }
        if let since, !since.isEmpty {
            q.append(URLQueryItem(name: "since", value: since))
        }
        comp.queryItems = q.isEmpty ? nil : q
        guard let url = comp.url else { throw IOSBehindError.badURL }
        let req = authorizedRequest(url: url, method: "GET")
        let (data, http) = try await data(for: req)
        return try decode(SessionSamplesResponse.self, from: data, status: http.statusCode)
    }

    public func patchSession(sessionId: String, body: PatchSessionRequest) async throws -> UpdateSessionResponse {
        guard var comp = URLComponents(url: baseURL, resolvingAgainstBaseURL: true) else {
            throw IOSBehindError.badURL
        }
        var path = comp.path
        if path.hasSuffix("/") {
            path.removeLast()
        }
        let encodedSession = sessionId.pathSegmentPercentEncoded
        comp.path = "\(path)/sessions/\(encodedSession)"
        guard let url = comp.url else { throw IOSBehindError.badURL }
        let encoded = try jsonEncoder.encode(body)
        let req = authorizedRequest(url: url, method: "PATCH", body: encoded)
        let (data, http) = try await data(for: req)
        return try decode(UpdateSessionResponse.self, from: data, status: http.statusCode)
    }

    public func deleteSession(sessionId: String) async throws -> DeleteSessionResponse {
        guard var comp = URLComponents(url: baseURL, resolvingAgainstBaseURL: true) else {
            throw IOSBehindError.badURL
        }
        var path = comp.path
        if path.hasSuffix("/") {
            path.removeLast()
        }
        let encodedSession = sessionId.pathSegmentPercentEncoded
        comp.path = "\(path)/sessions/\(encodedSession)"
        guard let url = comp.url else { throw IOSBehindError.badURL }
        let req = authorizedRequest(url: url, method: "DELETE")
        let (data, http) = try await data(for: req)
        return try decode(DeleteSessionResponse.self, from: data, status: http.statusCode)
    }
}

private extension String {
    /// 单一路径段编码，保留 Flask `<path:session_id>` 所需的斜杠会被编码为 %2F。
    var pathSegmentPercentEncoded: String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return addingPercentEncoding(withAllowedCharacters: allowed) ?? self
    }
}
