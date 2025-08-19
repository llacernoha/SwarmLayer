function relacionar_nodos_peerid()
    % Obtener carpetas que comienzan con SERVITEL
    dirs = dir('SERVITEL*');
    dirs = dirs([dirs.isdir]);  % asegurarse de que son directorios

    % Inicializar arrays para resultados
    nombresOrdenador = {};
    peerIds = {};

    for i = 1:length(dirs)
        carpeta = dirs(i).name;
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

        % Se asume que solo hay un archivo JSON
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

    % Guardar en CSV opcional
    writetable(T, 'relacion_nodos_peerid.csv');
end
