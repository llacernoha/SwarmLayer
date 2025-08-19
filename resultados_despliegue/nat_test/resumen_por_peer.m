function resumen_por_peer()
    % ---------------------------------------------------------------------
    % Lee todos los .json del directorio y genera un resumen por peer:
    %   - NombreOrdenador (desde CSV)
    %   - Inicio       (primer timestamp)
    %   - Fin          (último timestamp)
    %   - DescargaPeer (bytes descargados desde otros peers)
    %   - DescargaHTTP (bytes descargados desde HTTP)
    %   - AportePeer   (bytes enviados a otros peers)
    %   - Q1, Q2, Q3   (número de segmentos de vídeo de calidad 1, 2 y 3)
    % Luego ordena por Inicio y:
    %   - Muestra la tabla
    %   - Guarda 'resumen_peers.csv'
    %   - Grafica duración de sesión
    % ---------------------------------------------------------------------

    % 1) Leer CSV con relación PeerId ⇄ NombreOrdenador
    mapa = readtable('relacion_nodos_peerid.csv', 'TextType', 'string');
    peerToNombre = containers.Map(mapa.PeerId, mapa.NombreOrdenador);

    % 2) Listar todos los .json en el directorio
    archivos = dir('*.json');
    nTotal  = numel(archivos);

    % 3) Definir niveles de calidad a reportar
    uniqQs = [1, 2, 3];
    nQ     = numel(uniqQs);

    % 4) Preallocar vectores y matriz de conteos
    peerIds       = strings(nTotal,1);
    Inicio        = NaT(nTotal,1);
    Fin           = NaT(nTotal,1);
    DescargaPeer  = zeros(nTotal,1);
    DescargaHTTP  = zeros(nTotal,1);
    qualityCounts = zeros(nTotal, nQ);
    contribMap    = containers.Map('KeyType','char','ValueType','double');

    % 5) Pase principal: leer cada JSON, contar métricas + calidad
    for i = 1:nTotal
        archivo = archivos(i).name;
        peerId  = erase(archivo, '.json');
        peerIds(i) = peerId;

        datos = jsondecode(fileread(archivo));
        if isempty(datos), continue; end

        % Timestamps
        ts = {datos.timestamp};
        tiempos = datetime(ts, ...
            'InputFormat','yyyy-MM-dd''T''HH:mm:ss.SSS''Z''', ...
            'TimeZone','UTC');
        tiempos.TimeZone = '';
        Inicio(i) = min(tiempos);
        Fin(i)    = max(tiempos);

        % Contadores locales
        dp = 0;  % descarga peer
        dh = 0;  % descarga http

        for j = 1:numel(datos)
            e = datos(j);
            b = e.bytes;

            % 5.1) Descarga
            if isfield(e,'source')
                if strcmp(e.source,'peer')
                    dp = dp + b;
                elseif strcmp(e.source,'http')
                    dh = dh + b;
                end
            end

            % 5.2) Aporte: sumamos b bytes al peer que envía (fromPeerId)
            if isfield(e,'fromPeerId')
                key = e.fromPeerId;
                if contribMap.isKey(key)
                    contribMap(key) = contribMap(key) + b;
                else
                    contribMap(key) = b;
                end
            end

            % 5.3) Calidad de vídeo: identificar nivel y contar segmento
            u = e.url;
            t = regexp(u, '/video/[^/]+/(\d+)/', 'tokens','once');
            if ~isempty(t)
                qid = str2double(t{1});
                idx = find(uniqQs == qid, 1);
                if ~isempty(idx)
                    qualityCounts(i, idx) = qualityCounts(i, idx) + 1;
                end
            end
        end

        DescargaPeer(i) = dp;
        DescargaHTTP(i) = dh;
    end

    % 6) Calcular aporte real de cada peer
    AportePeer = zeros(nTotal,1);
    for i = 1:nTotal
        pid = peerIds(i);
        if contribMap.isKey(pid)
            AportePeer(i) = contribMap(pid);
        end
    end

    % 7) Traducir peerId a NombreOrdenador
    nombres = strings(nTotal,1);
    for i = 1:nTotal
        pid = peerIds(i);
        if peerToNombre.isKey(pid)
            nombres(i) = peerToNombre(pid);
        else
            nombres(i) = pid;
        end
    end

    % 8) Construir tabla y añadir columnas Q1, Q2, Q3
    T = table( ...
        nombres, Inicio, Fin, ...
        DescargaPeer, DescargaHTTP, AportePeer, ...
        'VariableNames', { ...
            'NombreOrdenador','Inicio','Fin', ...
            'DescargaPeer','DescargaHTTP','AportePeer' ...
        } ...
    );
    for k = 1:nQ
        colName = sprintf('Q%d', uniqQs(k));
        T.(colName) = qualityCounts(:,k);
    end

    % 9) Ordenar por Inicio
    T = sortrows(T, 'Inicio');

    % 10) Mostrar, guardar CSV y graficar duración
    disp(T);
    writetable(T, 'resumen_peers.csv');

    duracion = seconds(T.Fin - T.Inicio);
    figure;
    bar(categorical(T.NombreOrdenador), duracion);
    ylabel('Duración (segundos)');
    title('Tiempo de actividad por nodo (ordenado por inicio)');
    grid on;
end
