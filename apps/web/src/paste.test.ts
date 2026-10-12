import { describe, expect, it } from 'vitest'
import {
  ingredientsFromText,
  sharedIngredients,
  titleFromUrl,
  withoutTextFragment,
} from './paste.ts'

describe('ingredientsFromText', () => {
  it('keeps just the ingredients from a pasted page', () => {
    const page = [
      'The Best Chili',
      'Jump to recipe · Print',
      'Ingredients',
      '▢ 2 pounds ground beef',
      '',
      '• 1 large onion, diced',
      'For the topping:',
      '- 1 cup sour cream',
      'Directions',
      'Brown the beef.',
      'Notes',
    ].join('\n')
    expect(ingredientsFromText(page)).toEqual([
      '2 pounds ground beef',
      '1 large onion, diced',
      'For the topping:',
      '1 cup sour cream',
    ])
  })

  it('takes everything when there are no headings', () => {
    expect(ingredientsFromText('2 eggs\r\n  1 cup   milk  \n\n')).toEqual([
      '2 eggs',
      '1 cup milk',
    ])
  })

  it.each([
    'Instructions:',
    'Method',
    'Steps',
    'Recipe Notes',
    'Nutrition Facts',
  ])('stops at "%s"', (heading) => {
    expect(
      ingredientsFromText(`Ingredients:\n1 lemon\n${heading}\nZest it.`),
    ).toEqual(['1 lemon'])
  })

  it('caps the number of lines', () => {
    expect(ingredientsFromText('x\n'.repeat(500))).toHaveLength(200)
  })
})

describe('titleFromUrl', () => {
  it.each([
    [
      'https://www.seriouseats.com/the-best-chili-recipe-5089384',
      'The Best Chili Recipe',
    ],
    ['https://blog.example/2024/05/green-curry/', 'Green Curry'],
    ['https://blog.example/recipes/dal.html', 'Dal'],
    ['https://blog.example/', ''],
    ['not a url', ''],
  ])('%s → %s', (url, title) => {
    expect(titleFromUrl(url)).toBe(title)
  })
})

describe('shared text', () => {
  it('drops the highlight link', () => {
    expect(withoutTextFragment('https://a.example/x/#:~:text=salt')).toBe(
      'https://a.example/x/',
    )
    expect(withoutTextFragment('https://a.example/x/#top')).toBe(
      'https://a.example/x/#top',
    )
  })

  it('treats several lines as an ingredient list, and a single line as a title', () => {
    expect(
      sharedIngredients('"2 eggs\n1 cup milk"\nhttps://a.example/x/#:~:text=2'),
    ).toBe('2 eggs\n1 cup milk')
    expect(sharedIngredients('Dal https://a.example/dal/')).toBeNull()
    expect(sharedIngredients(null)).toBeNull()
  })
})
