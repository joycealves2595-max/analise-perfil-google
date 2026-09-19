// Função que roda no servidor do Netlify (nunca no navegador do visitante).
// Busca dados reais de um perfil do Google usando a Places API (New),
// mantendo a chave de API segura e escondida.

export default async (req, context) => {
  try {
    const url = new URL(req.url);
    const name = url.searchParams.get('name');
    const city = url.searchParams.get('city') || '';

    if (!name) {
      return new Response(JSON.stringify({ error: 'missing_name' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const apiKey = process.env.GOOGLE_PLACES_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'missing_api_key' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const query = city ? `${name} ${city}` : name;

    // 1) Text Search — só campos básicos e baratos, pra achar o lugar certo.
    const searchRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.businessStatus'
      },
      body: JSON.stringify({ textQuery: query, languageCode: 'pt-BR' })
    });

    const searchData = await searchRes.json();

    if (!searchRes.ok) {
      return new Response(JSON.stringify({ error: 'google_api_error', details: searchData }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const places = searchData.places || [];

    if (places.length === 0) {
      return new Response(JSON.stringify({ found: false, name }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const placeId = places[0].id;

    // 2) Place Details — dados básicos e de contato (nível mais barato).
    // Adicionados: editorialSummary (descrição do perfil) e types (categorias secundárias).
    const detailsBasicRes = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,nationalPhoneNumber,websiteUri,regularOpeningHours,photos,primaryTypeDisplayName,businessStatus,editorialSummary,types'
      }
    });
    const basic = await detailsBasicRes.json();

    // 3) Place Details — nota e avaliações, EM CHAMADA SEPARADA.
    // Isso é de propósito: juntar esses campos com os de cima faria a
    // chamada inteira ser cobrada no nível mais caro. Separado, só essa
    // chamada específica entra na cota menor (1.000 grátis/mês).
    const detailsRatingRes = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'rating,userRatingCount'
      }
    });
    const ratingData = await detailsRatingRes.json();

    const secondaryTypesCount = (basic.types || []).length;

    const checks = [
      {
        title: 'Categoria',
        ok: !!basic.primaryTypeDisplayName,
        detail: basic.primaryTypeDisplayName
          ? `Categoria principal: "${basic.primaryTypeDisplayName.text}".`
          : 'Nenhuma categoria principal foi encontrada no perfil.'
      },
      {
        title: 'Categorias secundárias',
        ok: secondaryTypesCount >= 3,
        detail: secondaryTypesCount > 0
          ? `${secondaryTypesCount} categoria(s) associada(s) ao perfil. O ideal é ter 3 ou mais, cobrindo os diferentes serviços que você oferece.`
          : 'Nenhuma categoria secundária encontrada.'
      },
      {
        title: 'Telefone',
        ok: !!basic.nationalPhoneNumber,
        detail: basic.nationalPhoneNumber
          ? 'Telefone cadastrado e visível.'
          : 'Nenhum telefone foi encontrado no perfil.'
      },
      {
        title: 'Endereço',
        ok: !!basic.formattedAddress,
        detail: basic.formattedAddress || 'Nenhum endereço foi encontrado no perfil.'
      },
      {
        title: 'Horário de funcionamento',
        ok: !!(basic.regularOpeningHours && basic.regularOpeningHours.periods && basic.regularOpeningHours.periods.length > 0),
        detail: (basic.regularOpeningHours && basic.regularOpeningHours.periods && basic.regularOpeningHours.periods.length > 0)
          ? 'Horário de funcionamento preenchido.'
          : 'Horário de funcionamento não preenchido.'
      },
      {
        title: 'Fotos',
        ok: !!(basic.photos && basic.photos.length >= 5),
        detail: basic.photos && basic.photos.length > 0
          ? `${basic.photos.length} foto(s) encontradas. O ideal é ter 10 ou mais.`
          : 'Nenhuma foto encontrada no perfil.'
      },
      {
        title: 'Site',
        ok: !!basic.websiteUri,
        detail: basic.websiteUri ? 'Link do site cadastrado.' : 'Nenhum site cadastrado no perfil.'
      },
      {
        title: 'Descrição do perfil',
        ok: !!(basic.editorialSummary && basic.editorialSummary.text),
        detail: (basic.editorialSummary && basic.editorialSummary.text)
          ? 'Perfil possui descrição preenchida.'
          : 'Nenhuma descrição encontrada — esse campo ajuda o Google a entender e recomendar seu negócio.'
      },
      {
        title: 'Nota média',
        ok: !!(ratingData.rating && ratingData.rating >= 4.3),
        detail: ratingData.rating
          ? `${ratingData.rating.toFixed(1)} estrelas.`
          : 'Nenhuma avaliação encontrada ainda.'
      },
      {
        title: 'Quantidade de avaliações',
        ok: !!(ratingData.userRatingCount && ratingData.userRatingCount >= 20),
        detail: ratingData.userRatingCount
          ? `${ratingData.userRatingCount} avaliações no total.`
          : 'Nenhuma avaliação encontrada ainda.'
      }
    ];

    return new Response(JSON.stringify({
      found: true,
      name: (basic.displayName && basic.displayName.text) || name,
      address: basic.formattedAddress || '',
      checks
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'server_error', message: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const config = { path: '/api/analyze-profile' };
