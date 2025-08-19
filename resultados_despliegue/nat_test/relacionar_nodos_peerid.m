function relacionar_nodos_peerid()
    % Obtener carpetas que comienzan con V o G
    dirs = dir();
    dirs = dirs([dirs.isdir]);  % asegurarse que sean directorios
    
    % Inicializar arrays para resultados
    nombresOrdenador = {};
    peerIds = {};
    
    for i = 1:length(dirs)
        carpeta = dirs(i).name;
        % Usar expresión regular para que sean V1,V2,... o G1,G2,...
        if isempty(regexp(carpeta, '^(V\d+|G\d+)$', 'once'))
            continue; % ignorar carpetas que no coinciden
        end
        
        explorerPath = fullfile(carpeta, 'explorer');
        if ~isfolder(explorerPath)
            warning('No se encontró carpeta explorer en %s', carpeta);
            continue;
        end

        % Buscar archivo .json dentro de explorer
        jsonFiles = dir(fullfile(explorerPath, '*.json'));
        if isempty(jsonFiles)
            warning('No se encontró archivo JSON en %s', explorerPath);
            continue;
        end

        jsonName = jsonFiles(1).name;

        % Agregar a resultados
        nombresOrdenador{end+1} = carpeta;
        peerIds{end+1} = erase(jsonName, '.json');  % quitar extensión
    end

    % Crear tabla con los resultados
    T = table(nombresOrdenador', peerIds', ...
        'VariableNames', {'NombreOrdenador', 'PeerId'});

    % Mostrar tabla
    disp(T);

    % Guardar en CSV
    writetable(T, 'relacion_nodos_peerid.csv');
end
