# AuthGate — Atualizador de IP

Aplicativo Windows para manter atualizado o IP público da rede de uma unidade do AuthGate.

[Baixar instalador Windows](https://github.com/TropaDigital/AUTHGATE-IP-UPDATER/releases/latest/download/AuthGate-IP-Agent-Setup.exe) · [Versões publicadas](https://github.com/TropaDigital/AUTHGATE-IP-UPDATER/releases)

## Uso

1. Instale no computador conectado à rede da usina.
2. Entre com a instância e a conta do administrador.
3. Escolha a unidade e inicie as atualizações.

A partir daí, só a unidade configurada fica disponível. O IP é atualizado a cada cinco minutos; trocar a unidade exige novo login e senha. Fechar a janela mantém o aplicativo na bandeja. O monitoramento pode ser pausado e retomado para a mesma unidade. O aplicativo inicia no login do usuário Windows, desde que o monitoramento esteja habilitado.

A senha é armazenada usando a proteção do usuário do sistema operacional (`safeStorage`). Falhas de conexão e expiração do token são tratadas com novas tentativas. Uma instalação gerencia uma unidade; evite dois computadores atualizando a mesma unidade.

## Atualização automática

O programa consulta as releases públicas deste repositório ao abrir e a cada 30 minutos. Baixa a nova versão, aguarda a atualização de IP em andamento, instala silenciosamente e reinicia, preservando a unidade configurada. Nenhum token do GitHub é necessário nos computadores das usinas.

Novas versões são publicadas automaticamente após push em `main` ou execução manual do workflow **Publicar aplicativo Windows**. A versão gerada é `1.3.<run_number>`. Para mudar a linha de versão, altere também o workflow. Os testes precisam passar antes do build. A release só sai de rascunho depois de todos os arquivos serem enviados.

Cada release contém o instalador versionado, sua cópia com nome fixo para download, o `.blockmap` e `latest.yml`. Os executáveis ficam em Releases, não no histórico Git. Preserve releases anteriores para permitir downloads e atualizações em andamento.

Não altere `appId` ou o nome do produto sem planejar a migração. A publicação usa somente o `GITHUB_TOKEN` do próprio workflow com `contents: write`.

## Migração de instalações anteriores

As versões 1.1.x e 1.2.x consultavam `authgate.com.br/downloads/ip-updater`. O frontend possui redirecionamentos de compatibilidade que precisam ser publicados uma vez pelo DevOps. Depois que o computador instalar uma versão 1.3.x, as próximas atualizações passam diretamente pelo GitHub, sem depender de deploy do site. Alternativamente, execute o instalador atual sobre a instalação existente para migrar imediatamente.

## Nome do processo e instalação

O executável instalado se chama `AuthGate-IP-Agent.exe`; o instalador de download é `AuthGate-IP-Agent-Setup.exe`. A identidade `br.com.authgate.ipupdater`, o nome do produto e a pasta de configuração foram mantidos para preservar instalações existentes. O link de download antigo permanece como alias na release.

O instalador verifica os nomes exatos dos processos atual e antigo usando o plugin nativo NSIS, sem considerar qualquer processo cujo caminho comece com a pasta do aplicativo. Erros de enumeração interrompem a instalação, em vez de ignorar processos potencialmente ativos. Se o desinstalador antigo não iniciar ou retornar erro após as tentativas normais, a recuperação valida que a pasta corresponde à instalação atual e contém o executável e o pacote Electron. Somente então move a pasta inteira para um backup vizinho (`.authgate-backup-*`) e continua a instalação. Não apaga dados do usuário nem o backup. Se a pasta não puder ser validada ou movida, interrompe com um erro explícito. Se a nova instalação abortar depois da recuperação, tenta restaurar a pasta anterior, preservando também os arquivos parciais.

O diagnóstico fica em `%TEMP%\AuthGate-IP-Agent-install.log`, sem senhas ou tokens. O hook é aplicado por `npm run predist` a um template do electron-builder com SHA-256 fixado: mudanças na dependência exigem revisão explícita, em vez de aplicar o patch silenciosamente.

Antes de publicar, o workflow testa instalação, atualização da versão anterior, reinstalação, desinstalação, preservação da configuração e recuperação de um desinstalador corrompido ou que retorna código 7 no Windows.

## Desenvolvimento

Requer Node.js 22 ou superior.

```bash
npm ci
npm test
npm start
```

Para gerar e validar um instalador sem publicar:

```bash
npm run dist
node scripts/verify-release.cjs
```

O workflow gera o instalador Windows x64 em um runner Windows. Os testes usam Electron e API simulados; instalação, inicialização do Windows e atualização entre versões devem ser validadas em um PC Windows. Sem certificado configurado, o instalador não tem assinatura de editor.

Este repositório contém apenas o aplicativo. O frontend continua separado em `TropaDigital/AUTHGATE-FRONT`.
