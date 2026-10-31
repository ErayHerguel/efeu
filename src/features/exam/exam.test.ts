import { describe, expect, it } from 'vitest';
import { cleanQuestions, examGrade, gradeChoice, type Question } from './exam';

const q = (over: Partial<Question>): Question => ({
  kind: 'choice',
  question: 'Was erzeugen Mitochondrien?',
  options: ['ATP', 'DNA', 'Glukose', 'Proteine'],
  answer: 0,
  solution: 'ATP durch Zellatmung.',
  pageId: 'p1',
  ...over,
});

describe('Klausurmodus', () => {
  it('übernimmt nur brauchbare Fragen und korrigiert Seitenkennungen', () => {
    const cleaned = cleanQuestions(
      [
        q({}),
        q({ answer: 7 }),
        q({ options: ['nur eine'] }),
        q({ kind: 'open', options: ['x'], answer: 2, pageId: 'erfunden' }),
        q({ question: '  ' }),
      ],
      new Set(['p1']),
      'p1',
    );
    expect(cleaned).toHaveLength(2);
    expect(cleaned[1]).toMatchObject({ kind: 'open', options: [], answer: -1, pageId: 'p1' });
  });

  it('bewertet Auswahlfragen und rechnet Noten um', () => {
    expect(gradeChoice(q({}), 0).points).toBe(2);
    expect(gradeChoice(q({}), 2)).toEqual({ points: 0, feedback: 'Richtig wäre: ATP' });
    expect(gradeChoice(q({}), null).points).toBe(0);
    expect(examGrade(100)).toBe('1,0');
    expect(examGrade(72)).toBe('2,7');
    expect(examGrade(50)).toBe('4,0');
    expect(examGrade(49)).toBe('5,0');
  });
});
