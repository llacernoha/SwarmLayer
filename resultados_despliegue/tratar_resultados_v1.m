function analyze_logs(folder)
    % ANALYZE_LOGS - Analiza logs de fragmentos descargados por P2P y HTTP
    %
    % USO:
    %   analyze_logs('C:\ruta\a\los\logs')
    %   o simplemente analyze_logs si el script y los archivos están en la misma carpeta

    if nargin == 0
        folder = fileparts(mfilename('fullpath')); % carpeta del script
    end

    %% Leer archivos JSON
    files = dir(fullfile(folder, 'fragment-logs-*.json'));
    if isempty(files)
        error('No se encontraron archivos fragment-logs-*.json en la carpeta.');
    end

    allLogs = [];
    for k = 1:length(files)
        raw = fileread(fullfile(folder, files(k).name));
        logs = jsondecode(raw);
        allLogs = [allLogs; logs(:)];
    end

    %% Convertir timestamps
    timestamps = datetime({allLogs.timestamp}, ...
        'InputFormat', 'yyyy-MM-dd''T''HH:mm:ss.SSS''Z''', 'TimeZone', 'UTC');
    [timestamps, idx] = sort(timestamps);
    allLogs = allLogs(idx);

    %% Crear segmentos de 20 segundos
    tStart = min(timestamps);
    tEnd = max(timestamps);
    edges = tStart:seconds(20):tEnd;
    nBins = length(edges)-1;

    http_bytes = zeros(1, nBins);
    p2p_bytes = zeros(1, nBins);

    %% Acumular tráfico
    for i = 1:numel(allLogs)
        ts = datetime(allLogs(i).timestamp, ...
            'InputFormat', 'yyyy-MM-dd''T''HH:mm:ss.SSS''Z''', 'TimeZone', 'UTC');
        bin = find(ts >= edges(1:end-1) & ts < edges(2:end));
        if isempty(bin), continue; end

        bytes = allLogs(i).bytes;
        if ischar(bytes), bytes = str2double(bytes); end

        if strcmpi(allLogs(i).source, 'http')
            http_bytes(bin) = http_bytes(bin) + bytes;
        elseif strcmpi(allLogs(i).source, 'peer')
            p2p_bytes(bin) = p2p_bytes(bin) + bytes;
        end
    end

    %% Contar nodos descargando desde segmento 4 en adelante
    nodoSegments = containers.Map();
    for i = 1:numel(allLogs)
        if ~isfield(allLogs(i), 'peerId') || isempty(allLogs(i).peerId), continue; end
        nodo = allLogs(i).peerId;
        ts = datetime(allLogs(i).timestamp, ...
            'InputFormat', 'yyyy-MM-dd''T''HH:mm:ss.SSS''Z''', 'TimeZone', 'UTC');
        bin = find(ts >= edges(1:end-1) & ts < edges(2:end));
        if isempty(bin), continue; end
        if isKey(nodoSegments, nodo)
            nodoSegments(nodo) = [nodoSegments(nodo), bin];
        else
            nodoSegments(nodo) = bin;
        end
    end

    nodos_descargando = zeros(1, nBins);
    keysList = keys(nodoSegments);
    for i = 1:length(keysList)
        segs = unique(nodoSegments(keysList{i}));
        segs_eligible = segs(segs >= 4);
        if isempty(segs_eligible), continue; end
        seg_start = min(segs_eligible);
        seg_end = max(segs);
        nodos_descargando(seg_start:seg_end) = nodos_descargando(seg_start:seg_end) + 1;
    end

    %% Mostrar duración total
    fprintf('Duración de recepción: %.1f segundos\n', seconds(tEnd - tStart));

    %% Gráfica con barras únicas (apiladas)
    figure('Name','Tráfico total y Nodos descargando','NumberTitle','off');

    yyaxis left
    b = bar(edges(1:end-1), [http_bytes; p2p_bytes]', 'stacked');
    b(1).FaceColor = [0.2 0.2 0.9];  % HTTP
    b(2).FaceColor = [0 0.7 0];      % P2P
    b(1).EdgeColor = 'none';
    b(2).EdgeColor = 'none';
    ylabel('Bytes por 20s');
    legend({'HTTP', 'P2P'}, 'Location', 'northwest');
    title('Tráfico total (HTTP + P2P) y Nodos descargando');
    xtickformat('HH:mm:ss');
    grid on;

    yyaxis right
    p = plot(edges(1:end-1), nodos_descargando, '-', ...
        'LineWidth', 1.2, 'Color', [1 0.5 0]); % línea continua naranja
    p.DisplayName = 'Nodos'; % ← nombre personalizado en la leyenda
    ylabel('Nodos descargando contenido');
    ylim([0 max(nodos_descargando)+1]);
    yticks(0:1:max(nodos_descargando)+1);

    legend([b(1), b(2), p], {'HTTP', 'P2P', 'Nodos'}, 'Location', 'northwest');
end
